/** @jest-environment node */
const mockSaveSecrets = jest.fn()
jest.mock('./credentials', () => ({ saveAccountSecrets: (...args: unknown[]) => mockSaveSecrets(...args) }))

import { accountRow, IDS } from '@/lib/content-studio/testFixtures'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { disconnectSocialAccount, listSocialAccounts, saveConnectedAccounts, storedExternalId } from './accounts'
import type { EngineAccount } from './engineClient'

type AnyDb = Parameters<typeof listSocialAccounts>[0]
const TOKEN = 'live-token-must-never-leak'

const ENGINE_ACCOUNT: EngineAccount = {
  platform: 'linkedin',
  externalId: '42',
  displayName: 'AI4L',
  authorKind: 'organization',
  scopes: ['w_organization_social'],
  accessToken: TOKEN,
  refreshToken: 'refresh-secret',
  expiresAt: '2026-12-01T00:00:00.000Z',
}

beforeEach(() => jest.clearAllMocks())

describe('listSocialAccounts', () => {
  it('maps rows without any token field, bounded and ordered', async () => {
    const builder = createQueryBuilderMock({ data: [accountRow()], error: null })
    const accounts = await listSocialAccounts(createDbMock(builder) as unknown as AnyDb)

    expect(accounts).toEqual([expect.objectContaining({ id: IDS.account, platform: 'linkedin', authorKind: 'organization' })])
    expect(Object.keys(accounts[0])).not.toContain('accessToken')
    expect(builder.argsFor('limit')).toEqual([200])
  })

  it('throws database errors', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: null, error: { message: 'down' } }))
    await expect(listSocialAccounts(db as unknown as AnyDb)).rejects.toThrow('down')
  })
})

describe('disconnectSocialAccount', () => {
  function disconnectDbs(overrides: { accounts?: unknown; secrets?: unknown; audit?: unknown } = {}) {
    const accounts = createQueryBuilderMock(overrides.accounts ?? { data: accountRow({ status: 'disconnected' }), error: null })
    const secrets = createQueryBuilderMock(overrides.secrets ?? { data: null, error: null })
    const audit = createQueryBuilderMock(overrides.audit ?? { data: null, error: null })
    const builders: Record<string, typeof accounts> = { social_accounts: accounts, social_account_secrets: secrets }
    const db = createDbMock((table: string) => builders[table] ?? audit)
    return { db, accounts, secrets, audit }
  }

  it('sets the status to disconnected, wipes the stored tokens (no delete) and audits', async () => {
    const { db, accounts, secrets, audit } = disconnectDbs()

    const result = await disconnectSocialAccount(db as unknown as AnyDb, IDS.account, IDS.user)

    expect(result.status).toBe('disconnected')
    expect(accounts.argsFor('update')?.[0]).toMatchObject({ status: 'disconnected' })
    const [wipe] = secrets.argsFor('update') as [Record<string, unknown>]
    expect(wipe).toMatchObject({ access_token: '', refresh_token: null })
    expect(typeof wipe.expires_at).toBe('string')
    expect(secrets.argsFor('eq')).toEqual(['account_id', IDS.account])
    expect([...accounts.allFor('delete'), ...secrets.allFor('delete')]).toHaveLength(0)
    expect(audit.argsFor('insert')?.[0]).toMatchObject({ action: 'social_account.disconnected', subject_id: IDS.account, actor_id: IDS.user })
  })

  it('404s an unknown account without touching the secrets', async () => {
    const { db, secrets } = disconnectDbs({ accounts: { data: null, error: null } })
    await expect(disconnectSocialAccount(db as unknown as AnyDb, IDS.account, IDS.user)).rejects.toMatchObject({ status: 404 })
    expect(secrets.calls).toHaveLength(0)
  })

  it('fails loudly when the tokens could not be wiped, so the admin can retry', async () => {
    const { db, audit } = disconnectDbs({ secrets: { data: null, error: { message: 'secrets down' } } })
    await expect(disconnectSocialAccount(db as unknown as AnyDb, IDS.account, IDS.user)).rejects.toThrow('secrets down')
    expect(audit.calls).toHaveLength(0)
  })

  it('still returns when the audit insert fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db } = disconnectDbs({ audit: { data: null, error: { message: 'audit down' } } })

    await expect(disconnectSocialAccount(db as unknown as AnyDb, IDS.account, IDS.user)).resolves.toBeDefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('saveConnectedAccounts', () => {
  const INPUT = { provider: 'linkedin' as const, brandId: IDS.brand, actorId: IDS.user }

  function tables(existing: unknown) {
    const order: string[] = []
    const accounts = createQueryBuilderMock([
      { data: existing, error: null },
      { data: { id: IDS.account }, error: null },
      { data: null, error: null },
    ])
    const audit = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock((table: string) => (table === 'social_accounts' ? accounts : audit))
    mockSaveSecrets.mockImplementation(async () => {
      order.push(`secrets after ${accounts.allFor('update').length} update(s)`)
    })
    return { db, accounts, audit, order }
  }

  it('creates a new account as needs_reauth, stores the secrets, then marks it connected', async () => {
    const { db, accounts, audit, order } = tables(null)

    const ids = await saveConnectedAccounts(db as unknown as AnyDb, { ...INPUT, accounts: [ENGINE_ACCOUNT] })

    expect(ids).toEqual([IDS.account])
    const [row] = accounts.argsFor('insert') as [Record<string, unknown>]
    expect(row).toMatchObject({ platform: 'linkedin', external_id: '42', status: 'needs_reauth', author_kind: 'organization' })
    expect(JSON.stringify(row)).not.toContain(TOKEN)
    expect(order).toEqual(['secrets after 0 update(s)'])
    expect(accounts.allFor('update').at(-1)?.args[0]).toMatchObject({ status: 'connected', last_error: null })
    expect(mockSaveSecrets).toHaveBeenCalledWith(
      IDS.account,
      { accessToken: TOKEN, refreshToken: 'refresh-secret', expiresAt: '2026-12-01T00:00:00.000Z' },
      db
    )
    expect(JSON.stringify(audit.argsFor('insert'))).not.toContain(TOKEN)
  })

  it('updates an existing row without touching its status until the secrets are stored', async () => {
    const { db, accounts, order } = tables({ id: IDS.account })

    await saveConnectedAccounts(db as unknown as AnyDb, { ...INPUT, accounts: [ENGINE_ACCOUNT] })

    const updates = accounts.allFor('update').map((call) => call.args[0] as Record<string, unknown>)
    expect(updates[0]).not.toHaveProperty('status')
    expect(order).toEqual(['secrets after 1 update(s)'])
    expect(updates[1]).toMatchObject({ status: 'connected' })
    expect(accounts.allFor('insert')).toHaveLength(0)
  })

  it('never marks the account connected when the secret write fails', async () => {
    const { db, accounts } = tables({ id: IDS.account })
    mockSaveSecrets.mockRejectedValue(new Error('encryption key missing'))

    await expect(saveConnectedAccounts(db as unknown as AnyDb, { ...INPUT, accounts: [ENGINE_ACCOUNT] })).rejects.toThrow('encryption key missing')
    expect(accounts.allFor('update').some((call) => (call.args[0] as Record<string, unknown>).status === 'connected')).toBe(false)
  })

  it('namespaces mock destinations so they can never overwrite a real account', async () => {
    const { db, accounts } = tables(null)
    await saveConnectedAccounts(db as unknown as AnyDb, { ...INPUT, provider: 'mock', accounts: [ENGINE_ACCOUNT] })
    expect(accounts.allFor('eq')[1].args).toEqual(['external_id', 'mock:42'])
    expect((accounts.argsFor('insert') as [Record<string, unknown>])[0].external_id).toBe('mock:42')
    expect(storedExternalId('mock', 'mock:1')).toBe('mock:1')
    expect(storedExternalId('meta', '1')).toBe('1')
  })

  it('stops on a database error before storing any secret', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: null, error: { message: 'conflict', code: '23514' } }))
    await expect(saveConnectedAccounts(db as unknown as AnyDb, { ...INPUT, accounts: [ENGINE_ACCOUNT] })).rejects.toThrow('conflict')
    expect(mockSaveSecrets).not.toHaveBeenCalled()
  })
})

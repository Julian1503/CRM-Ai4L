/** @jest-environment node */
import { randomBytes } from 'node:crypto'

import { accountRow, IDS } from '@/lib/content-studio/testFixtures'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { disconnectSocialAccount } from './accounts'
import { loadAccountTokens, saveAccountSecrets } from './credentials'

/**
 * End to end through the real secretBox: once an account is disconnected its stored
 * credentials can no longer be decrypted, and a reconnect stores fresh, usable ones.
 */

type AnyDb = Parameters<typeof disconnectSocialAccount>[0]
type SecretRow = { access_token: string; refresh_token: string | null; expires_at: string | null }

const ORIGINAL_ENV = process.env

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    CONTENT_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '1',
  }
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

async function storedRow(tokens: { accessToken: string; refreshToken: string }): Promise<SecretRow> {
  const builder = createQueryBuilderMock({ data: null, error: null })
  await saveAccountSecrets(IDS.account, { ...tokens, expiresAt: null }, createDbMock(builder) as unknown as AnyDb)
  return (builder.argsFor('upsert') as [SecretRow])[0]
}

function readerFor(row: SecretRow): AnyDb {
  return createDbMock(createQueryBuilderMock({ data: row, error: null })) as unknown as AnyDb
}

it('leaves no decryptable token after a disconnect, and a reconnect stores fresh ones', async () => {
  const original = await storedRow({ accessToken: 'old-access', refreshToken: 'old-refresh' })
  await expect(loadAccountTokens(IDS.account, readerFor(original))).resolves.toMatchObject({ accessToken: 'old-access' })

  const secrets = createQueryBuilderMock({ data: null, error: null })
  const db = createDbMock((table: string) =>
    table === 'social_accounts'
      ? createQueryBuilderMock({ data: accountRow({ status: 'disconnected' }), error: null })
      : table === 'social_account_secrets'
        ? secrets
        : createQueryBuilderMock({ data: null, error: null })
  )
  await disconnectSocialAccount(db as unknown as AnyDb, IDS.account, IDS.user)

  const wiped = { ...original, ...(secrets.argsFor('update') as [Partial<SecretRow>])[0] } as SecretRow
  expect(wiped.refresh_token).toBeNull()
  await expect(loadAccountTokens(IDS.account, readerFor(wiped))).rejects.toThrow()

  const fresh = await storedRow({ accessToken: 'new-access', refreshToken: 'new-refresh' })
  await expect(loadAccountTokens(IDS.account, readerFor(fresh))).resolves.toMatchObject({
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
  })
})

/** @jest-environment node */
import { randomBytes } from 'node:crypto'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockAdmin = jest.fn()
jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockAdmin() }))

import { decryptSecret } from '@/lib/crypto/secretBox'

import { loadAccessToken, loadAccountTokens, saveAccountSecrets, tokenAad } from './credentials'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const ORIGINAL_ENV = process.env

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    CONTENT_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '3',
  }
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

type Upserted = { access_token: string; refresh_token: string | null; key_version: number; expires_at: string | null }

describe('saveAccountSecrets', () => {
  it('stores only encrypted envelopes, bound to the account and field', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(builder)

    await saveAccountSecrets(ACCOUNT, { accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00Z' }, db as never)

    const [row, options] = builder.argsFor('upsert') as [Upserted, unknown]
    expect(db.from).toHaveBeenCalledWith('social_account_secrets')
    expect(options).toEqual({ onConflict: 'account_id' })
    expect(JSON.stringify(row)).not.toMatch(/"access"|"refresh"/)
    expect(row.key_version).toBe(3)
    expect(row.expires_at).toBe('2030-01-01T00:00:00Z')
    expect(decryptSecret(row.access_token, tokenAad(ACCOUNT, 'access_token'))).toBe('access')
    expect(decryptSecret(row.refresh_token as string, tokenAad(ACCOUNT, 'refresh_token'))).toBe('refresh')
  })

  it('stores no refresh token when none is given, and uses the admin client by default', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    mockAdmin.mockReturnValue(createDbMock(builder))

    await saveAccountSecrets(ACCOUNT, { accessToken: 'access' })

    const [row] = builder.argsFor('upsert') as [Upserted]
    expect(row.refresh_token).toBeNull()
    expect(row.expires_at).toBeNull()
  })

  it('refuses invalid input before touching the database', async () => {
    const db = createDbMock(createQueryBuilderMock())

    await expect(saveAccountSecrets('nope', { accessToken: 'x' }, db as never)).rejects.toThrow(/UUID/)
    await expect(saveAccountSecrets(ACCOUNT, { accessToken: ' ' }, db as never)).rejects.toThrow(/accessToken/)
    await expect(saveAccountSecrets(ACCOUNT, { accessToken: 'a', refreshToken: 'x'.repeat(9000) }, db as never)).rejects.toThrow(
      /refreshToken/
    )
    expect(db.from).not.toHaveBeenCalled()
  })

  it('reports a database failure without echoing the token', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: null, error: { message: 'boom' } }))

    await expect(saveAccountSecrets(ACCOUNT, { accessToken: 'secret-token' }, db as never)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-token') })
    )
  })
})

describe('loadAccessToken / loadAccountTokens', () => {
  async function stored(tokens: { accessToken: string; refreshToken?: string | null }) {
    const builder = createQueryBuilderMock({ data: null, error: null })
    await saveAccountSecrets(ACCOUNT, tokens, createDbMock(builder) as never)
    const [row] = builder.argsFor('upsert') as [Upserted]
    return row
  }

  it('decrypts the stored access token', async () => {
    const row = await stored({ accessToken: 'the-token' })
    const db = createDbMock(createQueryBuilderMock({ data: row, error: null }))

    await expect(loadAccessToken(ACCOUNT, db as never)).resolves.toBe('the-token')
  })

  it('returns null when nothing is stored', async () => {
    mockAdmin.mockReturnValue(createDbMock(createQueryBuilderMock({ data: null, error: null })))

    await expect(loadAccessToken(ACCOUNT)).resolves.toBeNull()
    await expect(loadAccountTokens(ACCOUNT)).resolves.toBeNull()
  })

  it('refuses a token copied from another account', async () => {
    const row = await stored({ accessToken: 'the-token' })
    const other = '22222222-2222-4222-8222-222222222222'
    const db = createDbMock(createQueryBuilderMock({ data: row, error: null }))

    await expect(loadAccessToken(other, db as never)).rejects.toThrow(/could not be decrypted/)
  })

  it('returns every token for a refresh flow', async () => {
    const row = await stored({ accessToken: 'a', refreshToken: 'r' })
    const db = createDbMock(createQueryBuilderMock({ data: { ...row, expires_at: null }, error: null }))

    await expect(loadAccountTokens(ACCOUNT, db as never)).resolves.toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: null })
  })

  it('returns a null refresh token when none is stored', async () => {
    const row = await stored({ accessToken: 'a' })
    const db = createDbMock(createQueryBuilderMock({ data: row, error: null }))

    await expect(loadAccountTokens(ACCOUNT, db as never)).resolves.toMatchObject({ refreshToken: null })
  })

  it('surfaces a read failure', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: null, error: { message: 'down' } }))

    await expect(loadAccessToken(ACCOUNT, db as never)).rejects.toThrow(/down/)
  })
})

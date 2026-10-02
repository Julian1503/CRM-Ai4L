/** @jest-environment node */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import {
  consumeOAuthState,
  createOAuthState,
  hashState,
  isProviderAllowed,
  parseOAuthOptions,
  STATE_TTL_MS,
} from './oauthState'

const ACTOR = '00000000-0000-4000-8000-000000000001'
const BRAND = '00000000-0000-4000-8000-00000000b001'
const NOW = new Date('2026-10-07T10:00:00.000Z')

type AnyDb = Parameters<typeof createOAuthState>[0]

describe('createOAuthState', () => {
  it('stores only the SHA-256 of a random 32-byte state, expiring in 10 minutes', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(builder)

    const state = await createOAuthState(db as unknown as AnyDb, { provider: 'linkedin', actorId: ACTOR, brandId: BRAND, options: { authorKind: 'member' } }, NOW)

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(db.from).toHaveBeenCalledWith('social_oauth_states')
    const [row] = builder.argsFor('insert') as [Record<string, unknown>]
    expect(row).toEqual({
      state_hash: hashState(state),
      provider: 'linkedin',
      actor_id: ACTOR,
      brand_id: BRAND,
      options: { authorKind: 'member' },
      expires_at: new Date(NOW.getTime() + STATE_TTL_MS).toISOString(),
    })
    expect(JSON.stringify(row)).not.toContain(state)
  })

  it('never returns the same state twice', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: null, error: null }))
    const input = { provider: 'meta' as const, actorId: ACTOR, brandId: BRAND, options: {} }
    const first = await createOAuthState(db as unknown as AnyDb, input)
    const second = await createOAuthState(db as unknown as AnyDb, input)
    expect(first).not.toBe(second)
  })

  it('surfaces a database error', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: null, error: { message: 'boom', code: '23505' } }))
    await expect(createOAuthState(db as unknown as AnyDb, { provider: 'meta', actorId: ACTOR, brandId: BRAND, options: {} })).rejects.toThrow('boom')
  })
})

describe('consumeOAuthState', () => {
  const STATE = 'a'.repeat(43)

  it('consumes atomically: unconsumed, unexpired, same provider and same administrator', async () => {
    const builder = createQueryBuilderMock({ data: { brand_id: BRAND, options: { authorKind: 'member', extra: 3 } }, error: null })
    const db = createDbMock(builder)

    const consumed = await consumeOAuthState(db as unknown as AnyDb, { state: STATE, provider: 'linkedin', actorId: ACTOR }, NOW)

    expect(consumed).toEqual({ brandId: BRAND, options: { authorKind: 'member' } })
    expect(builder.argsFor('update')).toEqual([{ consumed_at: NOW.toISOString() }])
    expect(builder.allFor('eq').map((call) => call.args)).toEqual([
      ['state_hash', hashState(STATE)],
      ['provider', 'linkedin'],
      ['actor_id', ACTOR],
    ])
    expect(builder.argsFor('is')).toEqual(['consumed_at', null])
    expect(builder.argsFor('gt')).toEqual(['expires_at', NOW.toISOString()])
  })

  it('returns null when no row matches (replayed, expired or another actor)', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: null, error: null }))
    await expect(consumeOAuthState(db as unknown as AnyDb, { state: STATE, provider: 'meta', actorId: ACTOR })).resolves.toBeNull()
  })

  it('rejects a malformed state without touching the database', async () => {
    const db = createDbMock(createQueryBuilderMock())
    await expect(consumeOAuthState(db as unknown as AnyDb, { state: 'short', provider: 'meta', actorId: ACTOR })).resolves.toBeNull()
    await expect(consumeOAuthState(db as unknown as AnyDb, { state: `${'a'.repeat(20)}'or'1'='1`, provider: 'meta', actorId: ACTOR })).resolves.toBeNull()
    expect(db.from).not.toHaveBeenCalled()
  })

  it('treats non-object options as empty', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: { brand_id: BRAND, options: ['x'] }, error: null }))
    await expect(consumeOAuthState(db as unknown as AnyDb, { state: STATE, provider: 'meta', actorId: ACTOR })).resolves.toEqual({ brandId: BRAND, options: {} })
  })
})

describe('isProviderAllowed', () => {
  it('always allows the real providers and refuses unknown names', () => {
    expect(isProviderAllowed('meta', { NODE_ENV: 'production' })).toBe(true)
    expect(isProviderAllowed('linkedin', { NODE_ENV: 'production' })).toBe(true)
    expect(isProviderAllowed('twitter', { NODE_ENV: 'development' })).toBe(false)
  })

  it('allows mock outside production, or in production only when opted in', () => {
    expect(isProviderAllowed('mock', { NODE_ENV: 'development' })).toBe(true)
    expect(isProviderAllowed('mock', { NODE_ENV: 'production' })).toBe(false)
    expect(isProviderAllowed('mock', { NODE_ENV: 'production', CONTENT_SOCIAL_ALLOW_MOCK: 'true' })).toBe(true)
  })
})

describe('parseOAuthOptions', () => {
  it('keeps no options for Meta and defaults LinkedIn to an organization', () => {
    expect(parseOAuthOptions('meta', { authorKind: 'member' })).toEqual({})
    expect(parseOAuthOptions('linkedin', {})).toEqual({ authorKind: 'organization' })
    expect(parseOAuthOptions('linkedin', { authorMode: 'member' })).toEqual({ authorKind: 'member' })
    expect(parseOAuthOptions('mock', { authorKind: 'member' })).toEqual({ authorKind: 'member' })
  })

  it('refuses an unknown author kind', () => {
    expect(parseOAuthOptions('linkedin', { authorKind: 'page' })).toBeNull()
  })
})

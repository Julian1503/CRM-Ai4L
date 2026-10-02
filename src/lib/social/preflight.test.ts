/** @jest-environment node */
const mockLoadTokens = jest.fn()
jest.mock('./credentials', () => ({ loadAccountTokens: (...args: unknown[]) => mockLoadTokens(...args) }))

import { accountRow, assetRow, IDS, revisionRow, variantRow } from '@/lib/content-studio/testFixtures'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { evaluatePreflight, loadPreflightFacts, revisionAssetRefs, runPreflight, socialImage, type PreflightFacts } from './preflight'

type AnyDb = Parameters<typeof loadPreflightFacts>[0]
const ORIGINAL_ENV = process.env
const NOW = new Date('2026-10-07T10:00:00.000Z')

function facts(overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    revision: revisionRow({ link_url: null }),
    variant: variantRow({ channel: 'linkedin', current_revision_id: IDS.revision }),
    account: accountRow(),
    approved: true,
    assets: [assetRow()],
    token: { kind: 'present', tokens: { accessToken: 't', expiresAt: '2027-01-01T00:00:00.000Z' } },
    now: NOW,
    ...overrides,
  }
}

const codes = (result: ReturnType<typeof evaluatePreflight>, blocking = true) =>
  result.issues.filter((issue) => issue.blocking === blocking).map((issue) => issue.code)

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...ORIGINAL_ENV, CONTENT_SOCIAL_PLATFORMS: 'facebook,instagram,linkedin' }
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

describe('evaluatePreflight', () => {
  it('passes an approved current revision on a connected, enabled account', () => {
    const result = evaluatePreflight(facts())
    expect(result).toMatchObject({ ok: true, platform: 'linkedin', composedText: 'Hello world.\n\nBook now.\n\n#AI4L' })
    expect(result.limits.maxChars).toBe(3000)
    expect(result.issues).toEqual([])
  })

  it.each<[string, Partial<PreflightFacts>, string]>([
    ['a superseded revision', { variant: variantRow({ channel: 'linkedin', current_revision_id: IDS.revision2 }) }, 'stale_revision'],
    ['an unapproved revision', { approved: false }, 'not_approved'],
    ['a disconnected account', { account: accountRow({ status: 'disconnected' }) }, 'account_not_connected'],
    ['another platform', { variant: variantRow({ channel: 'facebook', current_revision_id: IDS.revision }) }, 'channel_mismatch'],
    ['no stored token', { token: { kind: 'missing' } }, 'token_missing'],
    ['an unreadable token', { token: { kind: 'unreadable' } }, 'token_unreadable'],
    ['an expired token', { token: { kind: 'present', tokens: { accessToken: 't', expiresAt: '2026-10-01T00:00:00Z' } } }, 'token_expired'],
    ['a missing image', { assets: [null] }, 'asset_missing'],
    ['a removed image', { assets: [assetRow({ archived_at: 'x', removed_at: 'x' })] }, 'asset_missing'],
    ['an archived image', { assets: [assetRow({ archived_at: '2026-10-01T00:00:00Z' })] }, 'asset_archived'],
    ['an image still ingesting', { assets: [assetRow({ ingest_status: 'pending' })] }, 'asset_not_ready'],
    ['text over the limit', { revision: revisionRow({ body: 'a'.repeat(3001), link_url: null }) }, 'text_too_long'],
  ])('blocks %s', (_label, overrides, code) => {
    const result = evaluatePreflight(facts(overrides))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain(code)
  })

  it('blocks a platform the flag does not enable', () => {
    process.env = { ...ORIGINAL_ENV, CONTENT_SOCIAL_PLATFORMS: 'facebook' }
    expect(codes(evaluatePreflight(facts()))).toEqual(['platform_disabled'])
  })

  it('checks Instagram shape against the stored social rendition', () => {
    const instagram = { account: accountRow({ platform: 'instagram', author_kind: 'instagram_business' }), variant: variantRow({ channel: 'instagram', current_revision_id: IDS.revision }) }
    const narrow = assetRow({ renditions: { social: { path: 'p', mimeType: 'image/jpeg', byteSize: 1, width: 300, height: 300, checksum: 'b'.repeat(64) } } })
    expect(codes(evaluatePreflight(facts({ ...instagram, assets: [narrow] })))).toEqual(['image_too_small'])
    expect(codes(evaluatePreflight(facts({ ...instagram, assets: [], revision: revisionRow({ assets: [], link_url: null }) })))).toEqual(['image_required'])
  })

  it('warns, without blocking, about an expiring token and a link that will not be posted', () => {
    const result = evaluatePreflight(
      facts({
        revision: revisionRow(),
        token: { kind: 'present', tokens: { accessToken: 't', expiresAt: '2026-10-08T00:00:00.000Z' } },
      })
    )
    expect(result.ok).toBe(true)
    expect(codes(result, false)).toEqual(['token_expiring', 'link_not_posted'])
  })

  it('lists blocking issues before warnings', () => {
    const result = evaluatePreflight(facts({ revision: revisionRow({ hashtags: Array.from({ length: 101 }, (_, i) => `t${i}`) }), approved: false }))
    const firstWarning = result.issues.findIndex((issue) => !issue.blocking)
    expect(result.issues.slice(0, firstWarning === -1 ? undefined : firstWarning).every((issue) => issue.blocking)).toBe(true)
    expect(codes(result)).toEqual(['not_approved', 'too_many_hashtags'])
  })

  it('ignores a token without an expiry', () => {
    expect(evaluatePreflight(facts({ token: { kind: 'present', tokens: { accessToken: 't' } } })).issues).toEqual([])
  })
})

describe('helpers', () => {
  it('reads asset refs defensively and falls back to the original for dimensions', () => {
    expect(revisionAssetRefs(revisionRow({ assets: 'x' as never }))).toEqual([])
    expect(revisionAssetRefs(revisionRow({ assets: [{ nope: 1 }, { assetId: 'a', alt: '', order: 0 }] as never }))).toHaveLength(1)
    expect(socialImage(assetRow({ renditions: {} }))).toEqual({ mimeType: 'image/png', width: 800, height: 600 })
    expect(socialImage(assetRow({ renditions: {}, mime_type: null, width: null, height: null }))).toEqual({ mimeType: '', width: 0, height: 0 })
  })
})

function tables(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    content_variant_revisions: { data: revisionRow(), error: null },
    content_variants: { data: variantRow({ channel: 'linkedin', current_revision_id: IDS.revision }), error: null },
    social_accounts: { data: accountRow(), error: null },
    content_assets: { data: [assetRow()], error: null },
    ...overrides,
  }
  const builders: Record<string, ReturnType<typeof createQueryBuilderMock>> = {}
  const db = createDbMock((table: string) => (builders[table] ??= createQueryBuilderMock(responses[table])))
  db.rpc.mockResolvedValue({ data: true, error: null })
  return { db, builders }
}

describe('loadPreflightFacts / runPreflight', () => {
  const REQUEST = { revisionId: IDS.revision, accountId: IDS.account }

  it('reads everything with the member client and the token with the service role', async () => {
    const { db } = tables()
    const admin = { tag: 'admin' }
    mockLoadTokens.mockResolvedValue({ accessToken: 'secret', expiresAt: null })

    const { preflight, facts: loaded } = await runPreflight(db as unknown as AnyDb, admin as unknown as AnyDb, REQUEST)

    expect(preflight.ok).toBe(true)
    expect(loaded.assets).toHaveLength(1)
    expect(db.rpc).toHaveBeenCalledWith('content_revision_is_approved', { p_revision_id: IDS.revision })
    expect(mockLoadTokens).toHaveBeenCalledWith(IDS.account, admin)
    expect(JSON.stringify(preflight)).not.toContain('secret')
  })

  it('reports a token it cannot decrypt as unreadable, never the reason', async () => {
    const { db } = tables()
    mockLoadTokens.mockRejectedValue(new Error('bad key material 0xdeadbeef'))
    const { preflight } = await runPreflight(db as unknown as AnyDb, db as unknown as AnyDb, REQUEST)
    expect(codes(preflight)).toEqual(['token_unreadable'])
    expect(JSON.stringify(preflight)).not.toContain('deadbeef')
  })

  it('reports a missing token and skips the asset read for a text-only revision', async () => {
    const { db, builders } = tables({ content_variant_revisions: { data: revisionRow({ assets: [] }), error: null } })
    mockLoadTokens.mockResolvedValue(null)
    const { preflight } = await runPreflight(db as unknown as AnyDb, db as unknown as AnyDb, REQUEST)
    expect(codes(preflight)).toEqual(['token_missing'])
    expect(builders.content_assets).toBeUndefined()
  })

  it.each([
    ['revision', { content_variant_revisions: { data: null, error: null } }],
    ['variant', { content_variants: { data: null, error: null } }],
    ['account', { social_accounts: { data: null, error: null } }],
  ])('404s a missing %s', async (_label, overrides) => {
    const { db } = tables(overrides)
    await expect(loadPreflightFacts(db as unknown as AnyDb, db as unknown as AnyDb, REQUEST)).rejects.toMatchObject({ status: 404 })
  })

  it('throws database errors', async () => {
    const { db } = tables({ content_assets: { data: null, error: { message: 'assets down' } } })
    mockLoadTokens.mockResolvedValue(null)
    await expect(loadPreflightFacts(db as unknown as AnyDb, db as unknown as AnyDb, REQUEST)).rejects.toThrow('assets down')
  })
})

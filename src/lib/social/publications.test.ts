/** @jest-environment node */
const mockRunPreflight = jest.fn()
const mockPublishAsset = jest.fn()
jest.mock('./preflight', () => ({
  ...jest.requireActual('./preflight'),
  runPreflight: (...args: unknown[]) => mockRunPreflight(...args),
}))
jest.mock('@/lib/content-studio/assets', () => ({ publishAsset: (...args: unknown[]) => mockPublishAsset(...args) }))

import { IDS, publicationRow, revisionRow } from '@/lib/content-studio/testFixtures'
import type { PublishPreflight } from '@/lib/content-studio/types'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { listPublications, requestPublication } from './publications'

type AnyDb = Parameters<typeof listPublications>[0]
const REQUEST = { revisionId: IDS.revision, accountId: IDS.account, idempotencyKey: 'pub-12345678' }
const OK: PublishPreflight = { ok: true, platform: 'linkedin', composedText: 'x', limits: { maxChars: 3000, maxHashtags: 100, maxImages: 20, requiresImage: false }, issues: [] }

beforeEach(() => jest.clearAllMocks())

describe('listPublications', () => {
  it('lists the most recent publications without an item', async () => {
    const builder = createQueryBuilderMock({ data: [publicationRow()], error: null })
    const result = await listPublications(createDbMock(builder) as unknown as AnyDb, null)
    expect(result).toEqual([expect.objectContaining({ id: IDS.publication, status: 'queued' })])
    expect(builder.argsFor('in')).toBeUndefined()
    expect(builder.argsFor('limit')).toEqual([50])
  })

  it("scopes to the item's variants", async () => {
    const variants = createQueryBuilderMock({ data: [{ id: IDS.variant }], error: null })
    const publications = createQueryBuilderMock({ data: [publicationRow()], error: null })
    const db = createDbMock((table: string) => (table === 'content_variants' ? variants : publications))

    await listPublications(db as unknown as AnyDb, IDS.item)

    expect(variants.argsFor('eq')).toEqual(['item_id', IDS.item])
    expect(publications.argsFor('in')).toEqual(['variant_id', [IDS.variant]])
  })

  it('returns nothing for an item without variants', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: [], error: null }))
    await expect(listPublications(db as unknown as AnyDb, IDS.item)).resolves.toEqual([])
    expect(db.from).toHaveBeenCalledTimes(1)
  })
})

function db(existing: unknown = null) {
  const builder = createQueryBuilderMock({ data: existing, error: null })
  const mock = createDbMock(builder)
  mock.rpc.mockResolvedValue({ data: publicationRow(), error: null })
  return mock
}

describe('requestPublication', () => {
  it('returns the publication an idempotency key already created, without re-running anything', async () => {
    const mock = db(publicationRow({ status: 'published' }))
    const result = await requestPublication(mock as unknown as AnyDb, mock as unknown as AnyDb, IDS.user, REQUEST)
    expect(result.status).toBe('published')
    expect(mockRunPreflight).not.toHaveBeenCalled()
    expect(mock.rpc).not.toHaveBeenCalled()
  })

  it('refuses a blocking preflight with 422 preflight_failed and publishes nothing', async () => {
    mockRunPreflight.mockResolvedValue({
      preflight: { ...OK, ok: false, issues: [{ code: 'not_approved', message: 'Not approved.', blocking: true }, { code: 'w', message: 'meh', blocking: false }] },
      facts: { revision: revisionRow() },
    })
    const mock = db()
    await expect(requestPublication(mock as unknown as AnyDb, mock as unknown as AnyDb, IDS.user, REQUEST)).rejects.toMatchObject({
      status: 422,
      code: 'preflight_failed',
      message: 'Not approved.',
    })
    expect(mockPublishAsset).not.toHaveBeenCalled()
    expect(mock.rpc).not.toHaveBeenCalled()
  })

  it("publishes the revision's images in stored order and pins them in the RPC", async () => {
    const assets = [
      { assetId: IDS.asset2, alt: 'b', order: 0 },
      { assetId: IDS.asset, alt: 'a', order: 1 },
    ]
    mockRunPreflight.mockResolvedValue({ preflight: OK, facts: { revision: revisionRow({ assets }) } })
    mockPublishAsset.mockImplementation(async (_admin, assetId: string) => ({ id: `pub-${assetId}` }))
    const member = db()
    const admin = { tag: 'admin' }

    const result = await requestPublication(member as unknown as AnyDb, admin as unknown as AnyDb, IDS.user, REQUEST)

    expect(mockPublishAsset.mock.calls.map((call) => [call[0], call[1], call[2], call[3]])).toEqual([
      [admin, IDS.asset2, 'social', IDS.user],
      [admin, IDS.asset, 'social', IDS.user],
    ])
    expect(member.rpc).toHaveBeenCalledWith('request_social_publication', {
      p_revision_id: IDS.revision,
      p_account_id: IDS.account,
      p_published_asset_ids: [`pub-${IDS.asset2}`, `pub-${IDS.asset}`],
      p_idempotency_key: 'pub-12345678',
    })
    expect(result.id).toBe(IDS.publication)
  })

  it('surfaces an RPC refusal (e.g. already published) as a database error', async () => {
    mockRunPreflight.mockResolvedValue({ preflight: OK, facts: { revision: revisionRow({ assets: [] }) } })
    const mock = db()
    mock.rpc.mockResolvedValue({ data: null, error: { message: 'live', code: 'CRM06', hint: 'already_published' } })
    await expect(requestPublication(mock as unknown as AnyDb, mock as unknown as AnyDb, IDS.user, REQUEST)).rejects.toMatchObject({ hint: 'already_published' })
  })

  it('500s when the RPC returns nothing', async () => {
    mockRunPreflight.mockResolvedValue({ preflight: OK, facts: { revision: revisionRow({ assets: [] }) } })
    const mock = db()
    mock.rpc.mockResolvedValue({ data: null, error: null })
    await expect(requestPublication(mock as unknown as AnyDb, mock as unknown as AnyDb, IDS.user, REQUEST)).rejects.toMatchObject({ status: 500 })
  })
})

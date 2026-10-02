/** @jest-environment node */
import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

const mockLoadAccessToken = jest.fn()
jest.mock('@/lib/social/credentials', () => ({ loadAccessToken: (...args: unknown[]) => mockLoadAccessToken(...args) }))

import { CONTENT_BUCKETS, resetContentBucketsCache } from './assets'
import {
  accountRow,
  assetRow,
  brandRow,
  IDS,
  jobRow,
  publicationRow,
  publishedAssetRow,
  revisionRow,
  storageMock,
} from './testFixtures'
import { buildJobContext, findLeasedJob, INGEST_MAX_DIMENSION } from './workerContext'

function adminWith(tables: Record<string, unknown>) {
  const storage = storageMock()
  const builders = new Map<string, QueryBuilderMock>()
  const db = createDbMock((table: string) => {
    if (!builders.has(table)) builders.set(table, createQueryBuilderMock(tables[table] ?? { data: null, error: null }))
    return builders.get(table)
  })
  return { admin: Object.assign(db, { storage: storage.storage }), storage, builder: (t: string) => builders.get(t) as QueryBuilderMock }
}

const ORIGINAL_ENV = process.env

beforeEach(() => {
  resetContentBucketsCache()
  mockLoadAccessToken.mockReset()
  process.env = { ...ORIGINAL_ENV, CONTENT_SOCIAL_PLATFORMS: 'linkedin' }
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

describe('findLeasedJob', () => {
  it('matches the job only under its claim token, running, with a live lease', async () => {
    const { admin, builder } = adminWith({ content_jobs: { data: jobRow(), error: null } })

    await expect(findLeasedJob(admin as never, IDS.job, IDS.token)).resolves.toMatchObject({ id: IDS.job })

    const eqs = builder('content_jobs').allFor('eq').map((call) => call.args)
    expect(eqs).toEqual([
      ['id', IDS.job],
      ['claim_token', IDS.token],
      ['status', 'running'],
    ])
    expect(builder('content_jobs').argsFor('gte')?.[0]).toBe('lease_expires_at')
  })

  it('returns null context for a lost lease without reading anything else', async () => {
    const { admin } = adminWith({ content_jobs: { data: null, error: null } })

    await expect(buildJobContext(admin as never, IDS.job, IDS.token)).resolves.toBeNull()
    expect(admin.from).toHaveBeenCalledTimes(1)
  })
})

describe('generate_text', () => {
  it('carries the brand, the job input, the base revision and every platform limit', async () => {
    const { admin } = adminWith({
      content_jobs: { data: jobRow({ base_revision_id: IDS.revision }), error: null },
      content_items: { data: { brand_id: IDS.brand }, error: null },
      content_brand_profiles: { data: brandRow(), error: null },
      content_variant_revisions: { data: revisionRow(), error: null },
    })

    const context = await buildJobContext(admin as never, IDS.job, IDS.token)

    expect(context).toMatchObject({
      kind: 'generate_text',
      brand: { slug: 'ai4l', approvedFacts: [{ id: 'f1' }] },
      input: { itemId: IDS.item, channels: ['linkedin'] },
      baseRevision: { body: 'Hello world.', hashtags: ['AI4L'], assets: [{ assetId: IDS.asset }] },
    })
    expect(Object.keys((context as { platformLimits: object }).platformLimits)).toEqual(['facebook', 'instagram', 'linkedin', 'email'])
  })

  it('has no base revision for a fresh generation, and refuses a vanished item', async () => {
    const fresh = adminWith({
      content_jobs: { data: jobRow(), error: null },
      content_items: { data: { brand_id: IDS.brand }, error: null },
      content_brand_profiles: { data: brandRow(), error: null },
    })
    await expect(buildJobContext(fresh.admin as never, IDS.job, IDS.token)).resolves.toMatchObject({ baseRevision: null })

    const gone = adminWith({ content_jobs: { data: jobRow(), error: null }, content_items: { data: null, error: null } })
    await expect(buildJobContext(gone.admin as never, IDS.job, IDS.token)).rejects.toMatchObject({ status: 409, code: 'job_context_unavailable' })
  })

  it('keeps a null base revision when the revision cannot be found', async () => {
    const { admin } = adminWith({
      content_jobs: { data: jobRow({ base_revision_id: IDS.revision }), error: null },
      content_items: { data: { brand_id: IDS.brand }, error: null },
      content_brand_profiles: { data: brandRow(), error: null },
    })
    await expect(buildJobContext(admin as never, IDS.job, IDS.token)).resolves.toMatchObject({ baseRevision: null })
  })
})

describe('generate_image', () => {
  it('signs original/social/email uploads per image under generated/<jobId>/', async () => {
    const { admin, storage } = adminWith({
      content_jobs: { data: jobRow({ kind: 'generate_image', input: { itemId: IDS.item, prompt: 'p', count: 2, quality: 'low' } }), error: null },
      content_items: { data: { brand_id: IDS.brand }, error: null },
      content_brand_profiles: { data: brandRow(), error: null },
    })

    const context = await buildJobContext(admin as never, IDS.job, IDS.token)

    expect(context).toMatchObject({ kind: 'generate_image', uploadPrefix: `generated/${IDS.job}/` })
    const names = ['original.jpg', 'original.png', 'social.jpg', 'email.jpg', 'email.png']
    expect((context as { uploads: { path: string }[] }).uploads.map((upload) => upload.path)).toEqual([
      ...names.map((name) => `generated/${IDS.job}/0/${name}`),
      ...names.map((name) => `generated/${IDS.job}/1/${name}`),
    ])
    expect(storage.bucket(CONTENT_BUCKETS.library).createSignedUploadUrl).toHaveBeenCalledWith(`generated/${IDS.job}/0/original.jpg`, {
      upsert: true,
    })
  })

  it('clamps a malformed count to one image', async () => {
    const { admin } = adminWith({
      content_jobs: { data: jobRow({ kind: 'generate_image', input: { itemId: IDS.item, prompt: 'p', count: 'x' } }), error: null },
      content_items: { data: { brand_id: IDS.brand }, error: null },
      content_brand_profiles: { data: brandRow(), error: null },
    })

    const context = await buildJobContext(admin as never, IDS.job, IDS.token)
    expect((context as { uploads: unknown[] }).uploads).toHaveLength(5)
  })
})

describe('ingest_asset', () => {
  it('signs the quarantine download and the library uploads', async () => {
    const pending = assetRow({ ingest_status: 'pending' })
    const { admin, storage } = adminWith({
      content_jobs: { data: jobRow({ kind: 'ingest_asset', asset_id: IDS.asset, item_id: null }), error: null },
      content_assets: { data: pending, error: null },
    })

    const context = await buildJobContext(admin as never, IDS.job, IDS.token)

    expect(context).toMatchObject({
      kind: 'ingest_asset',
      assetId: IDS.asset,
      source: { mimeType: 'image/png', byteSize: 1000, filename: 'photo.png', signedUrl: expect.stringContaining(pending.quarantine_path as string) },
      uploadPrefix: `library/${IDS.asset}/`,
      maxDimension: INGEST_MAX_DIMENSION,
    })
    expect((context as { uploads: { path: string }[] }).uploads.map((upload) => upload.path)).toEqual(
      ['original.jpg', 'original.png', 'social.jpg', 'email.jpg', 'email.png'].map((name) => `library/${IDS.asset}/${name}`)
    )
    expect(storage.bucket(CONTENT_BUCKETS.quarantine).createSignedUrl).toHaveBeenCalledWith(pending.quarantine_path, 600)
  })

  it('refuses a vanished upload and reports a signing failure', async () => {
    const gone = adminWith({ content_jobs: { data: jobRow({ kind: 'ingest_asset', asset_id: IDS.asset }), error: null }, content_assets: { data: null, error: null } })
    await expect(buildJobContext(gone.admin as never, IDS.job, IDS.token)).rejects.toMatchObject({ status: 409 })

    const unsigned = adminWith({
      content_jobs: { data: jobRow({ kind: 'ingest_asset', asset_id: IDS.asset }), error: null },
      content_assets: { data: assetRow({ ingest_status: 'pending', mime_type: null, byte_size: null }), error: null },
    })
    unsigned.storage.bucket(CONTENT_BUCKETS.quarantine).createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'missing object' } })
    await expect(buildJobContext(unsigned.admin as never, IDS.job, IDS.token)).rejects.toThrow(/missing object/)
  })
})

describe('publish_social', () => {
  const tables = () => ({
    content_jobs: { data: jobRow({ kind: 'publish_social', publication_id: IDS.publication, checkpoint: { step: 'container' } }), error: null },
    social_publications: { data: publicationRow(), error: null },
    content_variant_revisions: { data: revisionRow(), error: null },
    social_accounts: { data: accountRow(), error: null },
    content_published_assets: { data: [publishedAssetRow()], error: null },
  })

  it('builds the post for the lease holder, with the decrypted token and pinned public images', async () => {
    mockLoadAccessToken.mockResolvedValue('decrypted-token')
    const { admin } = adminWith(tables())

    const context = await buildJobContext(admin as never, IDS.job, IDS.token)

    expect(context).toEqual({
      kind: 'publish_social',
      publicationId: IDS.publication,
      platform: 'linkedin',
      account: {
        id: IDS.account,
        provider: 'linkedin',
        externalId: 'urn:li:organization:1',
        authorKind: 'organization',
        displayName: 'AI4L',
        accessToken: 'decrypted-token',
      },
      text: 'Hello world.\n\nBook now.\n\n#AI4L',
      linkUrl: 'https://ai4l.example',
      images: [{ url: publishedAssetRow().public_url, alt: 'A photo', mimeType: 'image/jpeg', width: 800, height: 600 }],
      checkpoint: { step: 'container' },
    })
    expect(mockLoadAccessToken).toHaveBeenCalledWith(IDS.account, admin)
  })

  it('refuses when the platform is not enabled, before decrypting anything', async () => {
    process.env = { ...ORIGINAL_ENV, CONTENT_SOCIAL_PLATFORMS: '' }
    const { admin } = adminWith(tables())

    await expect(buildJobContext(admin as never, IDS.job, IDS.token)).rejects.toMatchObject({ status: 409, code: 'feature_disabled' })
    expect(mockLoadAccessToken).not.toHaveBeenCalled()
  })

  it('refuses a disconnected account or one without credentials', async () => {
    const disconnected = adminWith({ ...tables(), social_accounts: { data: accountRow({ status: 'needs_reauth' }), error: null } })
    await expect(buildJobContext(disconnected.admin as never, IDS.job, IDS.token)).rejects.toMatchObject({ code: 'account_not_connected' })

    mockLoadAccessToken.mockResolvedValue(null)
    const noToken = adminWith(tables())
    await expect(buildJobContext(noToken.admin as never, IDS.job, IDS.token)).rejects.toMatchObject({ code: 'account_not_connected' })
  })

  it('refuses a missing publication, target or published image', async () => {
    mockLoadAccessToken.mockResolvedValue('t')
    const noPublication = adminWith({ ...tables(), social_publications: { data: null, error: null } })
    await expect(buildJobContext(noPublication.admin as never, IDS.job, IDS.token)).rejects.toMatchObject({ status: 409 })

    const noAccount = adminWith({ ...tables(), social_accounts: { data: null, error: null } })
    await expect(buildJobContext(noAccount.admin as never, IDS.job, IDS.token)).rejects.toMatchObject({ status: 409 })

    const noImage = adminWith({ ...tables(), content_published_assets: { data: [], error: null } })
    await expect(buildJobContext(noImage.admin as never, IDS.job, IDS.token)).rejects.toMatchObject({ code: 'asset_mismatch' })
  })

  it('posts text only when no image is pinned', async () => {
    mockLoadAccessToken.mockResolvedValue('t')
    const { admin } = adminWith({
      ...tables(),
      content_jobs: { data: jobRow({ kind: 'publish_social', publication_id: IDS.publication, checkpoint: null }), error: null },
      social_publications: { data: publicationRow({ published_asset_ids: null as never }), error: null },
    })

    await expect(buildJobContext(admin as never, IDS.job, IDS.token)).resolves.toMatchObject({ images: [], checkpoint: {} })
    expect(admin.from).not.toHaveBeenCalledWith('content_published_assets')
  })

  it('keeps an empty alt when the revision lists fewer images than were pinned', async () => {
    mockLoadAccessToken.mockResolvedValue('t')
    const { admin } = adminWith({ ...tables(), content_variant_revisions: { data: revisionRow({ assets: [] }), error: null } })

    const context = await buildJobContext(admin as never, IDS.job, IDS.token)
    expect((context as { images: { alt: string }[] }).images[0].alt).toBe('')
  })
})

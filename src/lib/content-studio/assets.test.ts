/** @jest-environment node */
jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({}) }))

import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

import {
  CONTENT_BUCKETS,
  createUpload,
  displayPath,
  ensureContentBuckets,
  extensionFor,
  findAssetRow,
  listAssets,
  publishAsset,
  resetContentBucketsCache,
  sanitiseFilename,
  signDownloads,
  signUploads,
  updateAsset,
} from './assets'
import { assetRow, brandRow, IDS, itemRow, publishedAssetRow, storageMock } from './testFixtures'

function dbWith(tables: Record<string, unknown>, storage = storageMock()) {
  const builders = new Map<string, QueryBuilderMock>()
  const db = createDbMock((table: string) => {
    if (!builders.has(table)) builders.set(table, createQueryBuilderMock(tables[table] ?? { data: null, error: null }))
    return builders.get(table)
  })
  return { db: Object.assign(db, { storage: storage.storage }), storage, builder: (t: string) => builders.get(t) as QueryBuilderMock }
}

/** The audit action recorded through record_content_audit, if any. */
function auditAction(db: { rpc: jest.Mock }): unknown {
  return db.rpc.mock.calls.find((call) => call[0] === 'record_content_audit')?.[1]?.p_action
}

beforeEach(() => resetContentBucketsCache())

describe('names and paths', () => {
  it('sanitises file names into safe object names', () => {
    expect(sanitiseFilename('../../etc/Passwd.PNG')).toBe('passwd.png')
    expect(sanitiseFilename('C:\\Users\\me\\My Photo (1).jpg')).toBe('my-photo-1.jpg')
    expect(sanitiseFilename('...')).toBe('upload')
    expect(sanitiseFilename('ñandú.webp')).toBe('nandu.webp')
    expect(sanitiseFilename('a'.repeat(300) + '.png')).toHaveLength(100)
  })

  it('maps MIME types to extensions and refuses others', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg')
    expect(extensionFor('image/gif')).toBe('gif')
    expect(() => extensionFor('image/svg+xml')).toThrow(/Unsupported/)
  })

  it('displayPath prefers the social rendition of a ready asset', () => {
    expect(displayPath(assetRow())).toBe(`library/${IDS.asset}/social`)
    expect(displayPath(assetRow({ renditions: {} }))).toBe(`library/${IDS.asset}/original`)
    expect(displayPath(assetRow({ ingest_status: 'pending' }))).toBeNull()
  })
})

describe('buckets and signing', () => {
  it('creates missing buckets once and tolerates a concurrent creation', async () => {
    const { db, storage } = dbWith({})
    storage.storage.getBucket.mockResolvedValue({ data: null, error: { message: 'not found' } })
    storage.storage.createBucket.mockResolvedValueOnce({ data: null, error: { message: 'The resource already exists' } })

    await ensureContentBuckets(db as never)
    await ensureContentBuckets(db as never)

    expect(storage.storage.createBucket).toHaveBeenCalledTimes(3)
    expect(storage.storage.createBucket).toHaveBeenCalledWith(CONTENT_BUCKETS.public, expect.objectContaining({ public: true }))
  })

  it('retries after a failed bucket creation', async () => {
    const { db, storage } = dbWith({})
    storage.storage.getBucket.mockResolvedValue({ data: null, error: { message: 'not found' } })
    storage.storage.createBucket.mockResolvedValue({ data: null, error: { message: 'denied' } })

    await expect(ensureContentBuckets(db as never)).rejects.toThrow(/denied/)
    storage.storage.createBucket.mockResolvedValue({ data: { name: 'x' }, error: null })
    await expect(ensureContentBuckets(db as never)).resolves.toBeUndefined()
  })

  it('signs uploads in order and reports a failure', async () => {
    const { db, storage } = dbWith({})

    const uploads = await signUploads(db as never, CONTENT_BUCKETS.library, ['a', 'b'], true)

    expect(uploads.map((upload) => upload.path)).toEqual(['a', 'b'])
    expect(storage.bucket(CONTENT_BUCKETS.library).createSignedUploadUrl).toHaveBeenCalledWith('a', { upsert: true })

    storage.bucket(CONTENT_BUCKETS.library).createSignedUploadUrl.mockResolvedValueOnce({ data: null, error: { message: 'nope' } })
    await expect(signUploads(db as never, CONTENT_BUCKETS.library, ['c'], false)).rejects.toThrow(/nope/)
  })

  it('signs downloads, skipping entries that failed', async () => {
    const { db, storage } = dbWith({})
    storage.bucket(CONTENT_BUCKETS.library).createSignedUrls.mockResolvedValueOnce({
      data: [
        { path: 'a', signedUrl: 'https://a', error: null },
        { path: 'b', signedUrl: '', error: 'missing' },
      ],
      error: null,
    })

    await expect(signDownloads(db as never, CONTENT_BUCKETS.library, [])).resolves.toEqual(new Map())
    await expect(signDownloads(db as never, CONTENT_BUCKETS.library, ['a', 'b'])).resolves.toEqual(new Map([['a', 'https://a']]))

    storage.bucket(CONTENT_BUCKETS.library).createSignedUrls.mockResolvedValueOnce({ data: null, error: { message: 'x' } })
    await expect(signDownloads(db as never, CONTENT_BUCKETS.library, ['a'])).rejects.toThrow(/x/)
  })
})

describe('createUpload', () => {
  it('records a pending asset under a server-chosen quarantine path and returns its upload URL', async () => {
    const user = dbWith({
      content_items: { data: itemRow(), error: null },
      content_brand_profiles: { data: brandRow(), error: null },
      content_audit_events: { data: null, error: null },
    })
    const admin = dbWith({ content_assets: { data: assetRow({ ingest_status: 'pending' }), error: null } })

    const result = await createUpload(user.db as never, IDS.user, {
      filename: '../My Photo.PNG',
      mimeType: 'image/png',
      byteSize: 1234,
      itemId: IDS.item,
    }, admin.db as never)

    const [inserted] = admin.builder('content_assets').argsFor('insert') as [Record<string, unknown>]
    expect(inserted).toMatchObject({
      brand_id: IDS.brand,
      item_id: IDS.item,
      origin: 'upload',
      ingest_status: 'pending',
      mime_type: 'image/png',
      byte_size: 1234,
      created_by: IDS.user,
    })
    expect(inserted.quarantine_path).toBe(`uploads/${inserted.id}/my-photo.png`)
    expect(result.upload.path).toBe(inserted.quarantine_path)
    expect(admin.storage.bucket(CONTENT_BUCKETS.quarantine).createSignedUploadUrl).toHaveBeenCalledWith(inserted.quarantine_path, {
      upsert: false,
    })
    expect(result.asset.previewUrl).toBeNull()
  })

  it('refuses an upload for an unknown item', async () => {
    const user = dbWith({ content_items: { data: null, error: null } })
    const admin = dbWith({})

    await expect(
      createUpload(user.db as never, IDS.user, { filename: 'a.png', mimeType: 'image/png', byteSize: 1, itemId: IDS.item }, admin.db as never)
    ).rejects.toMatchObject({ status: 404 })
    expect(admin.db.from).not.toHaveBeenCalled()
  })

  it('creates a library upload without an item', async () => {
    const user = dbWith({ content_brand_profiles: { data: brandRow(), error: null } })
    const admin = dbWith({ content_assets: { data: assetRow({ item_id: null }), error: null } })

    await createUpload(user.db as never, IDS.user, { filename: 'a.png', mimeType: 'image/png', byteSize: 1 }, admin.db as never)

    expect((admin.builder('content_assets').argsFor('insert') as [Record<string, unknown>])[0].item_id).toBeNull()
  })
})

describe('listAssets / findAssetRow / updateAsset', () => {
  it('lists active assets for an item with signed previews', async () => {
    const user = dbWith({ content_assets: { data: [assetRow(), assetRow({ id: IDS.asset2, ingest_status: 'pending' })], error: null, count: 2 } })
    const admin = dbWith({})

    const result = await listAssets(user.db as never, { page: 1, pageSize: 20, itemId: IDS.item, status: 'active' }, admin.db as never)

    expect(result.total).toBe(2)
    expect(result.assets[0].previewUrl).toContain(`library/${IDS.asset}/social`)
    expect(result.assets[1].previewUrl).toBeNull()
    expect(user.builder('content_assets').argsFor('eq')).toEqual(['item_id', IDS.item])
  })

  it('reports the newest active job of each asset so the UI can resume polling', async () => {
    const user = dbWith({
      content_assets: { data: [assetRow({ ingest_status: 'pending' }), assetRow({ id: IDS.asset2 })], error: null, count: 2 },
      content_jobs: {
        data: [
          { id: 'job-new', asset_id: IDS.asset, created_at: '2026-10-08' },
          { id: 'job-old', asset_id: IDS.asset, created_at: '2026-10-07' },
          { id: 'orphan', asset_id: null, created_at: '2026-10-07' },
        ],
        error: null,
      },
    })

    const result = await listAssets(user.db as never, { page: 1, pageSize: 20, itemId: null, status: 'active' }, dbWith({}).db as never)

    expect(result.assets.map((asset) => asset.activeJobId)).toEqual(['job-new', null])
    expect(user.builder('content_jobs').allFor('in').map((call) => call.args)).toEqual([
      ['asset_id', [IDS.asset, IDS.asset2]],
      ['status', ['queued', 'running']],
    ])
  })

  it('surfaces an active-job read error', async () => {
    const user = dbWith({
      content_assets: { data: [assetRow()], error: null, count: 1 },
      content_jobs: { data: null, error: { message: 'jobs down' } },
    })
    await expect(listAssets(user.db as never, { page: 1, pageSize: 20, itemId: null, status: 'active' }, dbWith({}).db as never)).rejects.toThrow(
      'jobs down'
    )
  })

  it('lists archived library assets and handles a missing count', async () => {
    const user = dbWith({ content_assets: { data: null, error: null, count: null } })
    const result = await listAssets(user.db as never, { page: 1, pageSize: 20, itemId: null, status: 'archived' }, dbWith({}).db as never)

    expect(result).toEqual({ assets: [], total: 0 })
    expect(user.builder('content_assets').argsFor('not')).toEqual(['archived_at', 'is', null])
  })

  it('findAssetRow returns null for a missing asset', async () => {
    const { db } = dbWith({ content_assets: { data: null, error: null } })
    await expect(findAssetRow(db as never, IDS.asset)).resolves.toBeNull()
  })

  it('updateAsset edits alt text, archives, restores and audits', async () => {
    const edit = dbWith({
      content_assets: [{ data: assetRow(), error: null }, { data: assetRow({ alt_text: 'New' }), error: null }],
      content_audit_events: { data: null, error: null },
    })
    const asset = await updateAsset(edit.db as never, IDS.asset, IDS.user, { altText: 'New', archived: false }, edit.db as never)
    expect(asset?.altText).toBe('New')
    expect(edit.builder('content_assets').argsFor('update')).toEqual([{ alt_text: 'New' }])
    expect(auditAction(edit.db)).toBe('asset.updated')

    const archive = dbWith({
      content_assets: [{ data: assetRow(), error: null }, { data: assetRow({ archived_at: 'now' }), error: null }],
      content_audit_events: { data: null, error: null },
    })
    await updateAsset(archive.db as never, IDS.asset, IDS.user, { archived: true }, archive.db as never)
    expect(auditAction(archive.db)).toBe('asset.archived')

    const restore = dbWith({
      content_assets: [{ data: assetRow({ archived_at: 'then' }), error: null }, { data: assetRow(), error: null }],
      content_audit_events: { data: null, error: null },
    })
    await updateAsset(restore.db as never, IDS.asset, IDS.user, { archived: false }, restore.db as never)
    expect(restore.builder('content_assets').argsFor('update')).toEqual([{ archived_at: null }])
    expect(auditAction(restore.db)).toBe('asset.restored')

    const missing = dbWith({ content_assets: { data: null, error: null } })
    await expect(updateAsset(missing.db as never, IDS.asset, IDS.user, { altText: 'x' }, missing.db as never)).resolves.toBeNull()
  })
})

describe('publishAsset', () => {
  it('returns the existing published copy of the same bytes', async () => {
    const admin = dbWith({
      content_assets: { data: assetRow(), error: null },
      content_published_assets: { data: publishedAssetRow(), error: null },
    })

    const published = await publishAsset(admin.db as never, IDS.asset, 'social', IDS.user)

    expect(published).toMatchObject({ id: IDS.published, publicUrl: publishedAssetRow().public_url })
    expect(admin.storage.storage.from).not.toHaveBeenCalled()
  })

  it('copies the rendition to an immutable public path and records it', async () => {
    const admin = dbWith({
      content_assets: { data: assetRow(), error: null },
      content_published_assets: [{ data: null, error: null }, { data: publishedAssetRow(), error: null }],
    })

    await publishAsset(admin.db as never, IDS.asset, 'social', IDS.user)

    const [inserted] = admin.builder('content_published_assets').argsFor('insert') as [Record<string, string>]
    expect(inserted.storage_path).toBe(`p/${inserted.id}/${'b'.repeat(64)}.jpg`)
    expect(inserted.public_url).toContain(`public/${CONTENT_BUCKETS.public}/p/`)
    expect(inserted).toMatchObject({ purpose: 'social', mime_type: 'image/jpeg', created_by: IDS.user })
    expect(admin.storage.bucket(CONTENT_BUCKETS.library).copy).toHaveBeenCalledWith(`library/${IDS.asset}/social`, inserted.storage_path, {
      destinationBucket: CONTENT_BUCKETS.public,
    })
  })

  it('falls back to the original when there is no rendition for the purpose', async () => {
    const admin = dbWith({
      content_assets: { data: assetRow(), error: null },
      content_published_assets: [{ data: null, error: null }, { data: publishedAssetRow({ purpose: 'email' }), error: null }],
    })

    await publishAsset(admin.db as never, IDS.asset, 'email', null)

    expect((admin.builder('content_published_assets').argsFor('insert') as [Record<string, string>])[0]).toMatchObject({
      checksum: 'a'.repeat(64),
      mime_type: 'image/png',
    })
  })

  it('returns the winner of a concurrent publication', async () => {
    const admin = dbWith({
      content_assets: { data: assetRow(), error: null },
      content_published_assets: [
        { data: null, error: null },
        { data: null, error: { code: '23505', message: 'duplicate' } },
        { data: publishedAssetRow({ id: 'winner' }), error: null },
      ],
    })

    await expect(publishAsset(admin.db as never, IDS.asset, 'social', IDS.user)).resolves.toMatchObject({ id: 'winner' })
  })

  it.each([
    ['missing', { data: null, error: null }, 404],
    ['not ready', { data: assetRow({ ingest_status: 'pending' }), error: null }, 422],
  ])('refuses an asset that is %s', async (_name, response, status) => {
    const admin = dbWith({ content_assets: response })
    await expect(publishAsset(admin.db as never, IDS.asset, 'social', IDS.user)).rejects.toMatchObject({ status })
  })

  it('reports a copy failure', async () => {
    const admin = dbWith({ content_assets: { data: assetRow(), error: null }, content_published_assets: { data: null, error: null } })
    admin.storage.bucket(CONTENT_BUCKETS.library).copy.mockResolvedValueOnce({ data: null, error: { message: 'gone' } })

    await expect(publishAsset(admin.db as never, IDS.asset, 'social', IDS.user)).rejects.toThrow(/gone/)
  })
})

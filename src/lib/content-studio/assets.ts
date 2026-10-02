import 'server-only'

import { randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContentAssetFileRow, ContentAssetRow, ContentPublishedAssetRow, Database } from '@/lib/db/types'
import { getPageRange, type PageParams } from '@/lib/pagination'
import { getAdminClient } from '@/lib/supabase/admin'

import { recordAudit } from './audit'
import { ContentHttpError, throwIfDbError } from './errors'
import { toAsset } from './mappers'
import { findItemRow, getDefaultBrand } from './repository'
import type { ContentAsset, CreateUploadRequest, CreateUploadResponse, ListAssetsResponse, RenditionPurpose, SignedUpload } from './types'
import type { UpdateAssetRequest } from './validation'

/**
 * Asset storage (docs/CONTENT_STUDIO_CONTRACTS.md §4).
 *
 *   content-quarantine  private  raw uploads, written by the browser through a signed
 *                                upload URL for a path the server chose
 *   content-library     private  normalised originals and renditions, written by the
 *                                worker through signed upload URLs; previews are
 *                                short-lived signed URLs
 *   content-public      public   immutable published copies (emails, social providers)
 *
 * Every Storage call uses the service role, after the route has checked the session.
 * Worker upload targets are fixed when the URLs are signed, before the worker knows the
 * output format, so both extensions are offered where the format can vary
 * (original.jpg/original.png, email.jpg/email.png) plus social.jpg; the worker writes only
 * the ones it needs and reports their paths. Every worker upload URL is signed with
 * upsert, so a retried job rewrites the same paths (docs/CONTENT_STUDIO_CONTRACTS.md §4).
 */

type Db = SupabaseClient<Database>

export const CONTENT_BUCKETS = {
  quarantine: 'content-quarantine',
  library: 'content-library',
  public: 'content-public',
} as const

const FILE_SIZE_LIMIT = 15 * 1024 * 1024
const LIBRARY_MIME = ['image/jpeg', 'image/png', 'image/webp']
const BUCKET_OPTIONS: Record<string, { public: boolean; fileSizeLimit: number; allowedMimeTypes: string[] }> = {
  [CONTENT_BUCKETS.quarantine]: { public: false, fileSizeLimit: FILE_SIZE_LIMIT, allowedMimeTypes: [...LIBRARY_MIME, 'image/gif'] },
  [CONTENT_BUCKETS.library]: { public: false, fileSizeLimit: FILE_SIZE_LIMIT, allowedMimeTypes: LIBRARY_MIME },
  [CONTENT_BUCKETS.public]: { public: true, fileSizeLimit: FILE_SIZE_LIMIT, allowedMimeTypes: LIBRARY_MIME },
}

export const PREVIEW_URL_SECONDS = 600
export const ASSET_FILE_NAMES = ['original.jpg', 'original.png', 'social.jpg', 'email.jpg', 'email.png'] as const
const MAX_FILENAME_LENGTH = 100

let bucketsReady: Promise<void> | null = null

async function ensureBucket(admin: Db, id: string): Promise<void> {
  const { data } = await admin.storage.getBucket(id)
  if (data) return

  const { error } = await admin.storage.createBucket(id, BUCKET_OPTIONS[id])
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`Could not create the ${id} storage bucket: ${error.message}`)
  }
}

/**
 * Creates the three buckets when the migration could not (no storage schema at migration
 * time). Idempotent, and remembered for the life of the process once it succeeds.
 */
export function ensureContentBuckets(admin: Db): Promise<void> {
  if (!bucketsReady) {
    bucketsReady = Promise.all(Object.values(CONTENT_BUCKETS).map((id) => ensureBucket(admin, id)))
      .then(() => undefined)
      .catch((error: unknown) => {
        bucketsReady = null
        throw error
      })
  }
  return bucketsReady
}

/** Test hook: forget that the buckets were checked. */
export function resetContentBucketsCache(): void {
  bucketsReady = null
}

/** A safe object name from a user's file name: no directories, no odd characters. */
export function sanitiseFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+\./g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase()
    .slice(-MAX_FILENAME_LENGTH)

  return cleaned === '' ? 'upload' : cleaned
}

export const quarantinePath = (assetId: string, filename: string) => `uploads/${assetId}/${sanitiseFilename(filename)}`
export const libraryPrefix = (assetId: string) => `library/${assetId}/`
export const generatedPrefix = (jobId: string) => `generated/${jobId}/`

export function extensionFor(mimeType: string): string {
  const map: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
  const ext = map[mimeType]
  if (!ext) throw new ContentHttpError(422, `Unsupported image type ${mimeType}.`, 'asset_not_ready')
  return ext
}

/** One signed upload per path, in order. `upsert` lets a retried worker overwrite its own output. */
export async function signUploads(admin: Db, bucket: string, paths: readonly string[], upsert: boolean): Promise<SignedUpload[]> {
  return Promise.all(
    paths.map(async (path) => {
      const { data, error } = await admin.storage.from(bucket).createSignedUploadUrl(path, { upsert })
      if (error || !data) throw new Error(`Could not sign an upload URL: ${error?.message ?? 'no data'}`)
      return { path, signedUrl: data.signedUrl, token: data.token }
    })
  )
}

/** Short-lived signed download URLs, keyed by path. Paths that cannot be signed are absent. */
export async function signDownloads(admin: Db, bucket: string, paths: readonly string[], seconds = PREVIEW_URL_SECONDS): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map()
  const { data, error } = await admin.storage.from(bucket).createSignedUrls([...paths], seconds)
  if (error) throw new Error(`Could not sign download URLs: ${error.message}`)

  return new Map(
    (data ?? [])
      .filter((entry) => entry.path && entry.signedUrl && !entry.error)
      .map((entry) => [entry.path as string, entry.signedUrl as string])
  )
}

/** The library object a preview or export shows: the social rendition, else the original. */
export function displayPath(row: ContentAssetRow): string | null {
  if (row.ingest_status !== 'ready') return null
  return row.renditions?.social?.path ?? row.storage_path
}

export async function createUpload(
  db: Db,
  actorId: string,
  request: CreateUploadRequest,
  admin: Db = getAdminClient()
): Promise<CreateUploadResponse> {
  if (request.itemId && !(await findItemRow(db, request.itemId))) {
    throw new ContentHttpError(404, 'Item not found.')
  }

  const brand = await getDefaultBrand(db)
  const assetId = randomUUID()
  const path = quarantinePath(assetId, request.filename)

  await ensureContentBuckets(admin)
  const [upload] = await signUploads(admin, CONTENT_BUCKETS.quarantine, [path], false)

  const { data, error } = await admin
    .from('content_assets')
    .insert({
      id: assetId,
      brand_id: brand.id,
      item_id: request.itemId ?? null,
      origin: 'upload',
      ingest_status: 'pending',
      quarantine_path: path,
      mime_type: request.mimeType,
      byte_size: request.byteSize,
      original_filename: request.filename.slice(0, 255),
      created_by: actorId,
    })
    .select('*')
    .single()
  throwIfDbError(error)

  await recordAudit(db, { actorId, action: 'asset.upload_created', subjectType: 'content_asset', subjectId: assetId, details: { path } })
  return { asset: toAsset(data as ContentAssetRow, null), upload }
}

/** The newest queued or running job of each asset, so the UI can resume polling it. */
export async function readActiveJobs(db: Db, assetIds: string[]): Promise<Map<string, string>> {
  if (assetIds.length === 0) return new Map()
  const { data, error } = await db
    .from('content_jobs')
    .select('id, asset_id, created_at')
    .in('asset_id', assetIds)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(assetIds.length * 5)
  throwIfDbError(error)

  // Newest first, so the first job seen for an asset is the one kept.
  return (data ?? []).reduce(
    (active, job) => (job.asset_id && !active.has(job.asset_id) ? new Map(active).set(job.asset_id, job.id) : active),
    new Map<string, string>()
  )
}

async function withPreviews(db: Db, admin: Db, rows: ContentAssetRow[]): Promise<ContentAsset[]> {
  const paths = rows.map(displayPath).filter((path): path is string => path !== null)
  const [urls, jobs] = await Promise.all([
    signDownloads(admin, CONTENT_BUCKETS.library, paths),
    readActiveJobs(db, rows.map((row) => row.id)),
  ])
  return rows.map((row) => toAsset(row, urls.get(displayPath(row) ?? '') ?? null, jobs.get(row.id) ?? null))
}

export type ListAssetsParams = PageParams & { itemId: string | null; status: 'active' | 'archived' }

export async function listAssets(db: Db, params: ListAssetsParams, admin: Db = getAdminClient()): Promise<ListAssetsResponse> {
  const { from, to } = getPageRange(params)
  const base = db.from('content_assets').select('*', { count: 'exact' }).is('removed_at', null)
  const byStatus = params.status === 'archived' ? base.not('archived_at', 'is', null) : base.is('archived_at', null)
  const query = params.itemId ? byStatus.eq('item_id', params.itemId) : byStatus

  const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, to)
  throwIfDbError(error)

  return { assets: await withPreviews(db, admin, data ?? []), total: count ?? 0 }
}

export async function findAssetRow(db: Db, id: string): Promise<ContentAssetRow | null> {
  const { data, error } = await db.from('content_assets').select('*').eq('id', id).is('removed_at', null).maybeSingle()
  throwIfDbError(error)
  return data ?? null
}

/** Edits alt text and archives/restores. Null when the asset does not exist. */
export async function updateAsset(
  db: Db,
  id: string,
  actorId: string,
  request: UpdateAssetRequest,
  admin: Db = getAdminClient()
): Promise<ContentAsset | null> {
  const current = await findAssetRow(db, id)
  if (!current) return null

  const archiving = request.archived === true && current.archived_at === null
  const restoring = request.archived === false && current.archived_at !== null
  const patch = {
    ...(request.altText !== undefined ? { alt_text: request.altText } : {}),
    ...(archiving ? { archived_at: new Date().toISOString() } : {}),
    ...(restoring ? { archived_at: null } : {}),
  }

  const { data, error } = await db.from('content_assets').update(patch).eq('id', id).select('*').single()
  throwIfDbError(error)

  const action = archiving ? 'asset.archived' : restoring ? 'asset.restored' : 'asset.updated'
  await recordAudit(db, { actorId, action, subjectType: 'content_asset', subjectId: id, details: { fields: Object.keys(request) } })
  const [asset] = await withPreviews(db, admin, [data as ContentAssetRow])
  return asset
}

export type PublishedAsset = {
  id: string
  assetId: string
  purpose: RenditionPurpose
  publicUrl: string
  mimeType: string
  byteSize: number
  width: number
  height: number
  checksum: string
}

function toPublished(row: ContentPublishedAssetRow): PublishedAsset {
  return {
    id: row.id,
    assetId: row.asset_id,
    purpose: row.purpose,
    publicUrl: row.public_url,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    checksum: row.checksum,
  }
}

function sourceFile(asset: ContentAssetRow, purpose: RenditionPurpose): ContentAssetFileRow {
  const rendition = asset.renditions?.[purpose]
  if (rendition) return rendition
  return {
    path: asset.storage_path as string,
    mimeType: asset.mime_type as string,
    byteSize: asset.byte_size as number,
    width: asset.width as number,
    height: asset.height as number,
    checksum: asset.checksum as string,
  }
}

async function findPublished(admin: Db, assetId: string, purpose: RenditionPurpose, checksum: string) {
  const { data, error } = await admin
    .from('content_published_assets')
    .select('*')
    .eq('asset_id', assetId)
    .eq('purpose', purpose)
    .eq('checksum', checksum)
    .maybeSingle()
  throwIfDbError(error)
  return data ?? null
}

async function readReadyAsset(admin: Db, assetId: string): Promise<ContentAssetRow> {
  const { data, error } = await admin.from('content_assets').select('*').eq('id', assetId).is('removed_at', null).maybeSingle()
  throwIfDbError(error)
  if (!data) throw new ContentHttpError(404, 'Image not found.')
  if (data.ingest_status !== 'ready' || !data.storage_path) {
    throw new ContentHttpError(422, 'This image is not ready yet.', 'asset_not_ready')
  }
  return data
}

/**
 * Makes (or returns) the immutable public copy of an asset for a purpose. Idempotent on
 * (asset, purpose, checksum): the same bytes are published once and keep their URL for
 * good. Callers must have checked the member's session first.
 */
export async function publishAsset(admin: Db, assetId: string, purpose: RenditionPurpose, actorId: string | null): Promise<PublishedAsset> {
  const asset = await readReadyAsset(admin, assetId)
  const file = sourceFile(asset, purpose)
  const existing = await findPublished(admin, assetId, purpose, file.checksum)
  if (existing) return toPublished(existing)

  await ensureContentBuckets(admin)
  const id = randomUUID()
  const path = `p/${id}/${file.checksum}.${extensionFor(file.mimeType)}`
  const { error: copyError } = await admin.storage.from(CONTENT_BUCKETS.library).copy(file.path, path, { destinationBucket: CONTENT_BUCKETS.public })
  if (copyError) throw new Error(`Could not publish the image: ${copyError.message}`)

  const publicUrl = admin.storage.from(CONTENT_BUCKETS.public).getPublicUrl(path).data.publicUrl
  const { data, error } = await admin
    .from('content_published_assets')
    .insert({
      id, asset_id: assetId, purpose, storage_path: path, public_url: publicUrl, checksum: file.checksum,
      mime_type: file.mimeType, byte_size: file.byteSize, width: file.width, height: file.height, created_by: actorId,
    })
    .select('*')
    .single()

  if (error?.code === '23505') {
    // A concurrent request published the same bytes first; its row wins.
    const winner = await findPublished(admin, assetId, purpose, file.checksum)
    if (winner) return toPublished(winner)
  }
  throwIfDbError(error)
  return toPublished(data as ContentPublishedAssetRow)
}

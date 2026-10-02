import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContentJobRow, Database } from '@/lib/db/types'
import { loadAccessToken } from '@/lib/social/credentials'

import { ASSET_FILE_NAMES, CONTENT_BUCKETS, ensureContentBuckets, generatedPrefix, libraryPrefix, PREVIEW_URL_SECONDS, signUploads } from './assets'
import { ContentHttpError, throwIfDbError } from './errors'
import { isSocialPlatformEnabled } from './flags'
import { toBrandProfile, toRevision } from './mappers'
import { composePostText, PLATFORM_LIMITS } from './postText'
import { getBrand } from './repository'
import type {
  GenerateImageContext,
  GenerateImageInput,
  GenerateTextContext,
  GenerateTextInput,
  IngestAssetContext,
  JobContext,
  PublishImage,
  PublishSocialContext,
} from './types'

/**
 * Builds the context a worker needs for a job it holds the lease for. Built fresh on
 * every call from the authorised job record — never from anything the worker sends
 * besides the job id and claim token — so actor, brand and destination are the CRM's.
 *
 * The social access token appears only in a publish_social context, for the current
 * lease holder. Context bodies are never logged.
 */

type Db = SupabaseClient<Database>

export const INGEST_MAX_DIMENSION = 2048
const SOURCE_URL_SECONDS = PREVIEW_URL_SECONDS

/** The job, only while it is running under this claim token with a live lease. */
export async function findLeasedJob(admin: Db, jobId: string, claimToken: string): Promise<ContentJobRow | null> {
  const { data, error } = await admin
    .from('content_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('claim_token', claimToken)
    .eq('status', 'running')
    .gte('lease_expires_at', new Date().toISOString())
    .maybeSingle()
  throwIfDbError(error)
  return data ?? null
}

async function brandOfItem(admin: Db, itemId: string | null) {
  const { data, error } = await admin.from('content_items').select('brand_id').eq('id', itemId as string).maybeSingle()
  throwIfDbError(error)
  if (!data) throw new ContentHttpError(409, 'The item of this job no longer exists.', 'job_context_unavailable')
  return toBrandProfile(await getBrand(admin, data.brand_id))
}

async function generateTextContext(admin: Db, job: ContentJobRow): Promise<GenerateTextContext> {
  const brand = await brandOfItem(admin, job.item_id)
  let baseRevision: GenerateTextContext['baseRevision'] = null

  if (job.base_revision_id) {
    const { data, error } = await admin.from('content_variant_revisions').select('*').eq('id', job.base_revision_id).maybeSingle()
    throwIfDbError(error)
    if (data) {
      const { body, hashtags, callToAction, linkUrl, fields, assets } = toRevision(data, null)
      baseRevision = { body, hashtags, callToAction, linkUrl, fields, assets }
    }
  }

  return { kind: 'generate_text', brand, input: job.input as GenerateTextInput, baseRevision, platformLimits: { ...PLATFORM_LIMITS } }
}

async function generateImageContext(admin: Db, job: ContentJobRow): Promise<GenerateImageContext> {
  const brand = await brandOfItem(admin, job.item_id)
  const input = job.input as GenerateImageInput
  const prefix = generatedPrefix(job.id)
  const count = Math.min(Math.max(Number(input.count) || 1, 1), 4)
  const paths = Array.from({ length: count }, (_, index) => ASSET_FILE_NAMES.map((name) => `${prefix}${index}/${name}`)).flat()

  await ensureContentBuckets(admin)
  return { kind: 'generate_image', brand, input, uploadPrefix: prefix, uploads: await signUploads(admin, CONTENT_BUCKETS.library, paths, true) }
}

async function ingestAssetContext(admin: Db, job: ContentJobRow): Promise<IngestAssetContext> {
  const { data: asset, error } = await admin.from('content_assets').select('*').eq('id', job.asset_id as string).maybeSingle()
  throwIfDbError(error)
  if (!asset?.quarantine_path) throw new ContentHttpError(409, 'The upload of this job no longer exists.', 'job_context_unavailable')

  await ensureContentBuckets(admin)
  const { data: source, error: signError } = await admin.storage
    .from(CONTENT_BUCKETS.quarantine)
    .createSignedUrl(asset.quarantine_path, SOURCE_URL_SECONDS)
  if (signError || !source) throw new Error(`Could not sign the upload for processing: ${signError?.message ?? 'no data'}`)

  const prefix = libraryPrefix(asset.id)
  return {
    kind: 'ingest_asset',
    assetId: asset.id,
    source: {
      signedUrl: source.signedUrl,
      mimeType: asset.mime_type ?? 'application/octet-stream',
      byteSize: asset.byte_size ?? 0,
      filename: asset.original_filename,
    },
    uploadPrefix: prefix,
    uploads: await signUploads(admin, CONTENT_BUCKETS.library, ASSET_FILE_NAMES.map((name) => `${prefix}${name}`), true),
    maxDimension: INGEST_MAX_DIMENSION,
  }
}

async function readPublishTarget(admin: Db, job: ContentJobRow) {
  const { data: publication, error } = await admin.from('social_publications').select('*').eq('id', job.publication_id as string).maybeSingle()
  throwIfDbError(error)
  if (!publication) throw new ContentHttpError(409, 'The publication of this job no longer exists.', 'job_context_unavailable')

  const [revisionResult, accountResult] = await Promise.all([
    admin.from('content_variant_revisions').select('*').eq('id', publication.revision_id).maybeSingle(),
    admin.from('social_accounts').select('*').eq('id', publication.account_id).maybeSingle(),
  ])
  throwIfDbError(revisionResult.error)
  throwIfDbError(accountResult.error)
  if (!revisionResult.data || !accountResult.data) {
    throw new ContentHttpError(409, 'The publication target no longer exists.', 'job_context_unavailable')
  }
  return { publication, revision: revisionResult.data, account: accountResult.data }
}

async function readPublishImages(admin: Db, publishedIds: string[], alts: string[]): Promise<PublishImage[]> {
  if (publishedIds.length === 0) return []
  const { data, error } = await admin.from('content_published_assets').select('*').in('id', publishedIds)
  throwIfDbError(error)

  const byId = new Map((data ?? []).map((row) => [row.id, row]))
  if (byId.size !== new Set(publishedIds).size) {
    throw new ContentHttpError(409, 'A published image of this post is missing.', 'asset_mismatch')
  }
  return publishedIds.map((id, index) => {
    const row = byId.get(id)!
    return { url: row.public_url, alt: alts[index] ?? '', mimeType: row.mime_type, width: row.width, height: row.height }
  })
}

async function publishSocialContext(admin: Db, job: ContentJobRow): Promise<PublishSocialContext> {
  const { publication, revision, account } = await readPublishTarget(admin, job)
  if (!isSocialPlatformEnabled(account.platform)) {
    throw new ContentHttpError(409, `Publishing to ${account.platform} is not enabled.`, 'feature_disabled')
  }
  if (account.status !== 'connected') {
    throw new ContentHttpError(409, 'The account needs to be reconnected.', 'account_not_connected')
  }

  const content = toRevision(revision, null)
  const alts = [...content.assets].sort((a, b) => a.order - b.order).map((ref) => ref.alt)
  const [images, accessToken] = await Promise.all([
    readPublishImages(admin, publication.published_asset_ids ?? [], alts),
    loadAccessToken(account.id, admin),
  ])
  if (!accessToken) throw new ContentHttpError(409, 'The account has no stored credentials.', 'account_not_connected')

  return {
    kind: 'publish_social',
    publicationId: publication.id,
    platform: account.platform,
    account: {
      id: account.id,
      provider: account.provider,
      externalId: account.external_id,
      authorKind: account.author_kind,
      displayName: account.display_name,
      accessToken,
    },
    text: composePostText(content.body, content.callToAction, content.hashtags),
    linkUrl: content.linkUrl,
    images,
    checkpoint: { ...((job.checkpoint as Record<string, unknown> | null) ?? {}) },
  }
}

const BUILDERS: Record<ContentJobRow['kind'], (admin: Db, job: ContentJobRow) => Promise<JobContext>> = {
  generate_text: generateTextContext,
  generate_image: generateImageContext,
  ingest_asset: ingestAssetContext,
  publish_social: publishSocialContext,
}

/** The context for the lease holder, or null when the lease is not (or no longer) held. */
export async function buildJobContext(admin: Db, jobId: string, claimToken: string): Promise<JobContext | null> {
  const job = await findLeasedJob(admin, jobId, claimToken)
  return job ? BUILDERS[job.kind](admin, job) : null
}

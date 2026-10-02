import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContentAssetRow, ContentItemRow, ContentJobRow, Database } from '@/lib/db/types'

import { ContentHttpError, throwIfDbError } from './errors'
import { CONTENT_JOB_MEMBER_COLUMNS, toBrief, toJob, type MemberJobRow } from './mappers'
import type {
  ContentJob,
  GenerateImageInput,
  GenerateImagesRequest,
  GenerateRequest,
  GenerateTextInput,
  IngestAssetInput,
  ResolveJobRequest,
} from './types'

/**
 * Durable jobs requested by a member: generation, image generation and ingestion are
 * queued through enqueue_content_job (idempotent on the key); publish_social jobs are
 * created only by request_social_publication. The job input is a snapshot taken now —
 * a later edit of the item's brief does not change a job already queued — and never
 * contains a secret.
 */

type Db = SupabaseClient<Database>

function assertActiveItem(item: ContentItemRow): void {
  if (item.archived_at) {
    throw new ContentHttpError(409, 'Restore this item before generating content for it.')
  }
}

async function enqueue(
  db: Db,
  args: Database['public']['Functions']['enqueue_content_job']['Args']
): Promise<ContentJob> {
  const { data, error } = await db.rpc('enqueue_content_job', args)
  throwIfDbError(error)
  return toJob(data as unknown as ContentJobRow)
}

/** Checks a regeneration's variant: it must belong to the item and be of the channel asked. */
async function assertRegenerationTarget(db: Db, item: ContentItemRow, request: GenerateRequest): Promise<void> {
  const { data, error } = await db
    .from('content_variants')
    .select('id, item_id, channel, archived_at')
    .eq('id', request.variantId as string)
    .maybeSingle()
  throwIfDbError(error)

  if (!data || data.item_id !== item.id || data.archived_at) {
    throw new ContentHttpError(404, 'That variant does not belong to this item.')
  }
  if (data.channel !== request.channels[0]) {
    throw new ContentHttpError(422, `This variant is for ${data.channel}.`, 'channel_mismatch')
  }
}

export async function enqueueGeneration(db: Db, item: ContentItemRow, request: GenerateRequest): Promise<ContentJob> {
  assertActiveItem(item)
  const outside = request.channels.filter((channel) => !item.channels.includes(channel))
  if (outside.length > 0) {
    throw new ContentHttpError(422, `This item is not planned for ${outside.join(', ')}.`, 'channel_mismatch')
  }
  if (request.variantId) await assertRegenerationTarget(db, item, request)

  const input: GenerateTextInput = {
    itemId: item.id,
    channels: request.channels,
    stylesPerChannel: request.stylesPerChannel ?? 1,
    brief: toBrief(item.brief),
    ...(request.variantId ? { variantId: request.variantId, baseRevisionId: request.baseRevisionId } : {}),
    ...(request.instruction ? { instruction: request.instruction } : {}),
  }

  return enqueue(db, {
    p_kind: 'generate_text',
    p_idempotency_key: request.idempotencyKey,
    p_item_id: item.id,
    p_variant_id: request.variantId ?? null,
    p_base_revision_id: request.baseRevisionId ?? null,
    p_input: input,
  })
}

export async function enqueueImageGeneration(db: Db, item: ContentItemRow, request: GenerateImagesRequest): Promise<ContentJob> {
  assertActiveItem(item)
  const input: GenerateImageInput = {
    itemId: item.id,
    prompt: request.prompt,
    count: request.count,
    quality: request.quality ?? 'medium',
  }

  return enqueue(db, { p_kind: 'generate_image', p_idempotency_key: request.idempotencyKey, p_item_id: item.id, p_input: input })
}

/** The one idempotency key per asset: a double-clicked ingest lands on the same job. */
export function ingestKey(assetId: string): string {
  return `ingest:${assetId}`
}

export async function enqueueIngest(db: Db, asset: ContentAssetRow): Promise<ContentJob> {
  if (asset.origin !== 'upload' || !asset.quarantine_path) {
    throw new ContentHttpError(409, 'Only an uploaded image can be processed.')
  }
  if (asset.archived_at) {
    throw new ContentHttpError(409, 'Restore this image before processing it.')
  }
  if (asset.ingest_status !== 'pending') {
    throw new ContentHttpError(409, `This image has already been processed (${asset.ingest_status}).`, 'asset_not_pending')
  }

  const input: IngestAssetInput = { assetId: asset.id, quarantinePath: asset.quarantine_path }
  return enqueue(db, { p_kind: 'ingest_asset', p_idempotency_key: ingestKey(asset.id), p_asset_id: asset.id, p_input: input })
}

export async function getJob(db: Db, id: string): Promise<ContentJob | null> {
  const { data, error } = await db.from('content_jobs').select(CONTENT_JOB_MEMBER_COLUMNS).eq('id', id).maybeSingle()
  throwIfDbError(error)
  return data ? toJob(data as unknown as MemberJobRow) : null
}

/** Queued: cancelled now. Running: flagged; the worker stops before its next stage. */
export async function cancelJob(db: Db, id: string): Promise<ContentJob> {
  const { data, error } = await db.rpc('cancel_content_job', { p_job_id: id })
  throwIfDbError(error)
  return toJob(data as unknown as ContentJobRow)
}

/** A person settles an uncertain job after checking the provider. */
export async function resolveJob(db: Db, id: string, request: ResolveJobRequest): Promise<ContentJob> {
  // Only a publication has an outcome a person can confirm happened ("the post is live").
  // Any other uncertain job can only be closed as failed and generated again.
  if (request.resolution === 'succeeded') {
    const job = await getJob(db, id)
    if (!job) throw new ContentHttpError(404, 'Job not found.')
    if (job.kind !== 'publish_social') {
      throw new ContentHttpError(400, 'Only a publication can be marked as succeeded. Mark this job as failed and generate again.')
    }
  }
  const { data, error } = await db.rpc('resolve_uncertain_content_job', {
    p_job_id: id,
    p_resolution: request.resolution,
    p_note: request.note,
    p_external_id: request.externalId ?? null,
    p_permalink: request.permalink ?? null,
  })
  throwIfDbError(error)
  return toJob(data as unknown as ContentJobRow)
}

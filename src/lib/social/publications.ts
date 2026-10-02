import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { publishAsset } from '@/lib/content-studio/assets'
import { ContentHttpError, throwIfDbError } from '@/lib/content-studio/errors'
import { toPublication } from '@/lib/content-studio/mappers'
import type { PublishRequest, SocialPublication } from '@/lib/content-studio/types'
import type { Database, SocialPublicationRow } from '@/lib/db/types'

import { revisionAssetRefs, runPreflight } from './preflight'

/**
 * Publication requests and history.
 *
 * Requesting: an idempotency key already used returns that publication unchanged. Then
 * the preflight runs again (the dialog's result may be stale); any blocking issue is a
 * 422 `preflight_failed`. The revision's images get their immutable public social copies
 * (publishAsset, in the revision's stored order — the order request_social_publication
 * checks), and the RPC pins those ids, re-validates approval/account/channel and queues
 * the publish_social job, all in one transaction under the member's session.
 */

type Db = SupabaseClient<Database>

const RECENT_LIMIT = 50
const MAX_VARIANTS = 200

export async function listPublications(db: Db, itemId: string | null): Promise<SocialPublication[]> {
  let variantIds: string[] | null = null
  if (itemId) {
    const { data, error } = await db.from('content_variants').select('id').eq('item_id', itemId).limit(MAX_VARIANTS)
    throwIfDbError(error)
    variantIds = ((data ?? []) as { id: string }[]).map((row) => row.id)
    if (variantIds.length === 0) return []
  }

  let query = db.from('social_publications').select('*')
  if (variantIds) query = query.in('variant_id', variantIds)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(RECENT_LIMIT)
  throwIfDbError(error)
  return ((data ?? []) as SocialPublicationRow[]).map(toPublication)
}

async function findByIdempotencyKey(db: Db, key: string): Promise<SocialPublication | null> {
  const { data, error } = await db.from('social_publications').select('*').eq('idempotency_key', key).maybeSingle()
  throwIfDbError(error)
  return data ? toPublication(data as SocialPublicationRow) : null
}

export async function requestPublication(db: Db, admin: Db, actorId: string, request: PublishRequest): Promise<SocialPublication> {
  const existing = await findByIdempotencyKey(db, request.idempotencyKey)
  if (existing) return existing

  const { preflight, facts } = await runPreflight(db, admin, request)
  const blockers = preflight.issues.filter((issue) => issue.blocking)
  if (blockers.length > 0) {
    throw new ContentHttpError(422, blockers.map((issue) => issue.message).join(' '), 'preflight_failed')
  }

  const publishedIds: string[] = []
  for (const ref of revisionAssetRefs(facts.revision)) {
    publishedIds.push((await publishAsset(admin, ref.assetId, 'social', actorId)).id)
  }

  const { data, error } = await db.rpc('request_social_publication', {
    p_revision_id: request.revisionId,
    p_account_id: request.accountId,
    p_published_asset_ids: publishedIds,
    p_idempotency_key: request.idempotencyKey,
  })
  throwIfDbError(error)
  if (!data) throw new ContentHttpError(500, 'The publication could not be queued.')
  return toPublication(data as SocialPublicationRow)
}

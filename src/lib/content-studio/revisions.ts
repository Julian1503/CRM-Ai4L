import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContentReviewRow, ContentVariantRevisionRow, ContentVariantRow, Database } from '@/lib/db/types'

import { recordAudit } from './audit'
import { throwIfDbError } from './errors'
import { latestReviews, toRevision } from './mappers'
import { hydrateVariants } from './repository'
import type { ContentRevision, ContentVariant, DuplicateVariantRequest, SaveRevisionRequest, UpdateVariantRequest } from './types'

/**
 * The editorial workflow: saving an edit and duplicating a variant. Every integrity
 * rule (immutable revisions, stale-edit refusal, idempotency) lives in the SQL functions; this module calls
 * them with the member's client and shapes the result.
 */

type Db = SupabaseClient<Database>

async function latestReviewOf(db: Db, revisionId: string): Promise<ContentReviewRow | undefined> {
  const { data, error } = await db.from('content_reviews').select('*').eq('revision_id', revisionId).limit(100)
  throwIfDbError(error)
  return latestReviews(data ?? []).get(revisionId)
}

/**
 * Saves an edit as a new revision. `expectedRevisionId` is the revision the editor
 * opened; if the variant moved on since, the database refuses with CRM06 stale_revision.
 * A retried save (same idempotency key) returns the revision it created the first time,
 * with that revision's current review state.
 */
export async function saveRevision(db: Db, variantId: string, request: SaveRevisionRequest): Promise<ContentRevision> {
  const { data, error } = await db.rpc('create_content_revision', {
    p_variant_id: variantId,
    p_expected_revision_id: request.expectedRevisionId,
    p_content: request.content,
    p_idempotency_key: request.idempotencyKey,
  })
  throwIfDbError(error)

  const row = data as unknown as ContentVariantRevisionRow
  return toRevision(row, await latestReviewOf(db, row.id))
}

export async function duplicateVariant(db: Db, variantId: string, request: DuplicateVariantRequest): Promise<ContentVariant> {
  const { data, error } = await db.rpc('duplicate_content_variant', {
    p_variant_id: variantId,
    p_idempotency_key: request.idempotencyKey,
  })
  throwIfDbError(error)

  const [variant] = await hydrateVariants(db, [data as unknown as ContentVariantRow])
  return variant
}

/**
 * Archives or restores a variant (content changes are revisions, never edits here).
 * Null when the variant does not exist. Archiving an archived variant changes nothing.
 */
export async function updateVariant(
  db: Db,
  variantId: string,
  actorId: string,
  request: UpdateVariantRequest
): Promise<ContentVariant | null> {
  const { data: current, error } = await db.from('content_variants').select('*').eq('id', variantId).maybeSingle()
  throwIfDbError(error)
  if (!current) return null

  const changes = request.archived === (current.archived_at === null)
  if (!changes) return (await hydrateVariants(db, [current]))[0]

  const { data, error: updateError } = await db
    .from('content_variants')
    .update({ archived_at: request.archived ? new Date().toISOString() : null })
    .eq('id', variantId)
    .select('*')
    .single()
  throwIfDbError(updateError)

  await recordAudit(db, {
    actorId,
    action: request.archived ? 'variant.archived' : 'variant.restored',
    subjectType: 'content_variant',
    subjectId: variantId,
  })
  return (await hydrateVariants(db, [data as ContentVariantRow]))[0]
}

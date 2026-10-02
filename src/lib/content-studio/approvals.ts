import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContentReviewRow, Database } from '@/lib/db/types'

import { ContentHttpError, throwIfDbError } from './errors'
import type { ReviewDecision, ReviewRequest } from './types'

/**
 * Reviews (approve / reject) of a revision. Approval belongs to one immutable revision:
 * an edit creates a new revision and so voids it, and only a variant's current revision
 * can be reviewed or published (enforced by review_content_revision and
 * content_revision_is_approved in SQL).
 */

type Db = SupabaseClient<Database>

export type ContentReview = {
  id: string
  revisionId: string
  decision: ReviewDecision
  reason: string | null
  actorId: string | null
  createdAt: string
}

export function toReview(row: ContentReviewRow): ContentReview {
  return {
    id: row.id,
    revisionId: row.revision_id,
    decision: row.decision,
    reason: row.reason,
    actorId: row.actor_id,
    createdAt: row.created_at,
  }
}

/**
 * Approves or rejects a revision of this variant. The revision must belong to the
 * variant in the URL (404 otherwise); the database then refuses anything but the
 * variant's current revision (CRM06 stale_revision).
 */
export async function reviewRevision(db: Db, variantId: string, request: ReviewRequest): Promise<ContentReview> {
  const { data: revision, error: readError } = await db
    .from('content_variant_revisions')
    .select('id, variant_id')
    .eq('id', request.revisionId)
    .maybeSingle()
  throwIfDbError(readError)
  if (!revision || revision.variant_id !== variantId) {
    throw new ContentHttpError(404, 'That revision does not belong to this variant.')
  }

  const { data, error } = await db.rpc('review_content_revision', {
    p_revision_id: request.revisionId,
    p_decision: request.decision,
    p_reason: request.reason ?? null,
  })
  throwIfDbError(error)
  return toReview(data as unknown as ContentReviewRow)
}

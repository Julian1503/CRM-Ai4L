import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * Content audit trail (content_audit_events): who created, edited, archived, uploaded or
 * published what. The workflow functions in SQL write their own events; this records the
 * direct writes the API makes (items, assets, variant archive).
 *
 * Written through record_content_audit, which takes the actor from the session
 * (auth.uid()) and accepts only these actions, so a member can neither attribute an event
 * to someone else nor forge one the database records itself (an approval, a publication).
 * Called after the change it records has committed, so a failure is reported (logged,
 * returned) and does not undo or misreport that change. Details must never contain a secret.
 */

export const AUDIT_ACTIONS = [
  'item.created',
  'item.updated',
  'item.archived',
  'item.restored',
  'asset.upload_created',
  'asset.updated',
  'asset.archived',
  'asset.restored',
  'asset.published',
  'variant.archived',
  'variant.restored',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export type AuditEntry = {
  /** For the caller's context only: the database records auth.uid() as the actor. */
  actorId: string
  action: AuditAction
  subjectType: 'content_item' | 'content_variant' | 'content_asset' | 'content_published_asset'
  subjectId: string
  details?: Record<string, unknown>
}

type AuditRpc = (
  fn: 'record_content_audit',
  args: { p_action: string; p_subject_type: string; p_subject_id: string; p_details: Record<string, unknown> }
) => PromiseLike<{ error: { message: string } | null }>

export async function recordAudit(db: SupabaseClient<Database>, entry: AuditEntry): Promise<boolean> {
  const rpc = db.rpc.bind(db) as unknown as AuditRpc
  const { error } = await rpc('record_content_audit', {
    p_action: entry.action,
    p_subject_type: entry.subjectType,
    p_subject_id: entry.subjectId,
    p_details: entry.details ?? {},
  })

  if (error) {
    console.error(`Content audit event ${entry.action} was not recorded:`, error.message)
    return false
  }
  return true
}

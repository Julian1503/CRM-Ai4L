import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import { ARCHIVE_RULE_SQLSTATE } from '@/lib/lifecycle/lifecycle'

import { MAX_SELECTED_IDS } from './query'
import { isUuid } from './tags'

/**
 * Archive or remove an explicit selection of contacts (set_contacts_lifecycle).
 *
 * Both are soft deletes, the same as the single-contact PATCH: archive is undoable from
 * the Archive view, remove hides the contact everywhere. All or nothing, like bulk
 * tagging — see 20261028010000_bulk_contact_lifecycle.sql.
 */

export type BulkLifecycleAction = 'archive' | 'remove'

export type BulkLifecycleInput = { contactIds: string[]; action: BulkLifecycleAction }

export type BulkLifecycleResult =
  | { kind: 'applied'; updated: number }
  | { kind: 'invalid'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'forbidden' }

type RpcError = { code?: string; message: string; hint?: string }
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError | null }>

export function parseBulkLifecycleInput(
  body: Record<string, unknown>
): { ok: true; input: BulkLifecycleInput } | { ok: false; error: string } {
  const { contactIds, action } = body

  if (action !== 'archive' && action !== 'remove') {
    return { ok: false, error: 'action must be archive or remove.' }
  }
  if (!Array.isArray(contactIds) || !contactIds.every(isUuid)) {
    return { ok: false, error: 'contactIds must be a list of contact ids.' }
  }

  const contacts = [...new Set(contactIds.map((id) => id.toLowerCase()))]

  if (contacts.length === 0) return { ok: false, error: 'Select at least one contact.' }
  if (contacts.length > MAX_SELECTED_IDS) {
    return { ok: false, error: `Select at most ${MAX_SELECTED_IDS} contacts.` }
  }

  return { ok: true, input: { contactIds: contacts, action } }
}

/**
 * `conflict` covers a selection that went stale (CRM06: a contact archived or removed
 * meanwhile) and an archive rule a trigger raised (CRM01). Either way nothing changed and
 * the message says why, so both become one 409.
 */
export async function applyBulkLifecycle(
  db: SupabaseClient<Database>,
  input: BulkLifecycleInput
): Promise<BulkLifecycleResult> {
  const rpc = db.rpc.bind(db) as unknown as Rpc
  const { data, error } = await rpc('set_contacts_lifecycle', {
    p_contact_ids: input.contactIds,
    p_action: input.action,
  })

  if (error?.code === 'CRM06' || error?.code === ARCHIVE_RULE_SQLSTATE) {
    return { kind: 'conflict', message: error.message }
  }
  if (error?.code === 'CRM07') return { kind: 'invalid', message: error.message }
  if (error?.code === '42501') return { kind: 'forbidden' }
  if (error) throw new Error(`Could not ${input.action} contacts: ${error.message}`)

  const updated = (data as { updated?: unknown } | null)?.updated
  return { kind: 'applied', updated: typeof updated === 'number' ? updated : 0 }
}

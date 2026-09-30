import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database, TagSummary } from '@/lib/db/types'
import { getPageRange, type PageParams } from '@/lib/pagination'

import { escapeLikePattern, MAX_SELECTED_IDS } from './query'
import { isUuid, MAX_TAGS_PER_CONTACT } from './tags'

/**
 * Tag catalog reads and writes, and bulk tagging.
 *
 * Kept apart from `tags.ts`, which the import parser runs in the browser: this module
 * talks to the database. Every write goes through an RPC (create_tag,
 * apply_contact_tags) so normalisation, the unique name, the limits and the revision
 * bump are enforced in one place — see 20261006000000_contact_tags.sql.
 */

type RpcError = { code?: string; message: string; hint?: string }
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError | null }>

function rpcOf(db: SupabaseClient<Database>): Rpc {
  return db.rpc.bind(db) as unknown as Rpc
}

/** One page of the catalog, by name, optionally narrowed by a name substring. */
export async function listTags(
  db: SupabaseClient<Database>,
  params: PageParams & { q: string | null }
): Promise<{ tags: TagSummary[]; total: number }> {
  const { from, to } = getPageRange(params)
  let query = db.from('tags').select('id, name', { count: 'exact' })

  if (params.q) {
    query = query.ilike('name', `%${escapeLikePattern(params.q)}%`)
  }

  const { data, error, count } = await query.order('name', { ascending: true }).range(from, to)

  if (error) throw new Error(`Could not load tags: ${error.message}`)

  return { tags: (data ?? []).map((row) => ({ id: row.id, name: row.name })), total: count ?? 0 }
}

export type CreateTagResult =
  | { kind: 'ok'; tag: TagSummary; created: boolean }
  | { kind: 'invalid'; message: string }

/** Finds or creates a tag by name. An existing tag with the same key is returned as-is. */
export async function createTag(db: SupabaseClient<Database>, name: string): Promise<CreateTagResult> {
  const { data, error } = await rpcOf(db)('create_tag', { p_name: name })

  if (error?.code === 'CRM07') return { kind: 'invalid', message: error.message }
  if (error) throw new Error(`Could not create the tag: ${error.message}`)

  const result = data as { tag?: TagSummary; created?: boolean } | null
  if (!result?.tag) throw new Error('Creating the tag returned nothing.')

  return { kind: 'ok', tag: { id: result.tag.id, name: result.tag.name }, created: result.created === true }
}

export type TagOperation = 'add' | 'remove'

export type BulkTagInput = { contactIds: string[]; tagIds: string[]; operation: TagOperation }

/**
 * Shape-checks a bulk tagging request. Ids must be UUIDs; lists are deduplicated and
 * bounded. An empty selection is an error, never "every contact".
 */
export function parseBulkTagInput(
  body: Record<string, unknown>
): { ok: true; input: BulkTagInput } | { ok: false; error: string } {
  const { contactIds, tagIds, operation } = body

  if (operation !== 'add' && operation !== 'remove') {
    return { ok: false, error: 'operation must be add or remove.' }
  }
  if (!Array.isArray(contactIds) || !contactIds.every(isUuid)) {
    return { ok: false, error: 'contactIds must be a list of contact ids.' }
  }
  if (!Array.isArray(tagIds) || !tagIds.every(isUuid)) {
    return { ok: false, error: 'tagIds must be a list of tag ids.' }
  }

  const contacts = [...new Set(contactIds.map((id) => id.toLowerCase()))]
  const tags = [...new Set(tagIds.map((id) => id.toLowerCase()))]

  if (contacts.length === 0) return { ok: false, error: 'Select at least one contact.' }
  if (contacts.length > MAX_SELECTED_IDS) {
    return { ok: false, error: `Select at most ${MAX_SELECTED_IDS} contacts.` }
  }
  if (tags.length === 0) return { ok: false, error: 'Choose at least one tag.' }
  if (tags.length > MAX_TAGS_PER_CONTACT) {
    return { ok: false, error: `Choose at most ${MAX_TAGS_PER_CONTACT} tags.` }
  }

  return { ok: true, input: { contactIds: contacts, tagIds: tags, operation } }
}

export type ApplyTagsResult =
  | { kind: 'applied'; updated: number }
  | { kind: 'invalid'; message: string }
  | { kind: 'stale'; message: string }
  | { kind: 'forbidden' }

/**
 * Adds or removes tags on an explicit selection, all or nothing (apply_contact_tags).
 *
 * `stale` covers a selected contact that was archived or no longer exists (CRM06) and a
 * tag that no longer exists (CRM07, hint stale_tags): either way the fix is to refresh
 * the selection, which is why both become one 409.
 */
export async function applyContactTags(db: SupabaseClient<Database>, input: BulkTagInput): Promise<ApplyTagsResult> {
  const { data, error } = await rpcOf(db)('apply_contact_tags', {
    p_contact_ids: input.contactIds,
    p_tag_ids: input.tagIds,
    p_operation: input.operation,
  })

  if (error?.code === 'CRM06') return { kind: 'stale', message: error.message }
  if (error?.code === 'CRM07' && error.hint === 'stale_tags') return { kind: 'stale', message: error.message }
  if (error?.code === 'CRM07') return { kind: 'invalid', message: error.message }
  if (error?.code === '42501') return { kind: 'forbidden' }
  if (error) throw new Error(`Could not update tags: ${error.message}`)

  const updated = (data as { updated?: unknown } | null)?.updated
  return { kind: 'applied', updated: typeof updated === 'number' ? updated : 0 }
}

import type { SupabaseClient } from '@supabase/supabase-js'

import { parseContactFilters, type ContactFilters } from '@/lib/contacts/query'
import { applyContactFilters } from '@/lib/contacts/repository'
import type { ContactRow, Database } from '@/lib/db/types'

/**
 * Segments — stored filter definitions used to build campaign audiences.
 *
 * The definition reuses the contact-list filter vocabulary rather than inventing a
 * second query language, so a segment and a filtered list mean exactly the same thing,
 * and `parseContactFilters` does the whitelisting for both.
 *
 * The *definition* is stored, never a frozen member list, so a segment stays current as
 * contacts change.
 */

/**
 * Hard ceiling on how many contacts one segment can resolve to.
 *
 * The provider sends one API call per recipient against a token bucket of 100 refilling
 * at 10/sec, so 10,000 recipients is already ~17 minutes of queueing. This cap keeps a
 * mistyped filter from turning into an hours-long send.
 */
export const SEGMENT_MEMBER_CAP = 10_000

type SegmentDefinition = Record<string, unknown>

/**
 * Converts a stored definition into validated filters.
 *
 * Two invariants are forced regardless of what the stored JSON says, because a row can
 * be hand-edited or arrive from an older migration:
 *
 * - `subscribed` is always true. Marketing to contacts who never opted in is the
 *   Australian Spam Act exposure recorded in PLAN.md; a segment must not be able to
 *   express it.
 * - `includeArchived` is always false. Archived contacts are archived.
 */
export function segmentDefinitionToFilters(definition: unknown): ContactFilters {
  const source: SegmentDefinition =
    typeof definition === 'object' && definition !== null && !Array.isArray(definition)
      ? (definition as SegmentDefinition)
      : {}

  // Coerce to the string/string[] shape parseContactFilters expects, discarding
  // anything else rather than trusting it.
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      params[key] = value
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      params[key] = String(value)
    }
  }

  const filters = parseContactFilters(params)

  return {
    ...filters,
    subscribed: true,
    includeArchived: false,
    page: 1,
    pageSize: Math.min(filters.pageSize, SEGMENT_MEMBER_CAP),
  }
}

/** Serialises filters for storage, omitting pagination, which is not part of a segment. */
export function filtersToSegmentDefinition(filters: ContactFilters): SegmentDefinition {
  const definition: SegmentDefinition = {}

  if (filters.q) definition.q = filters.q
  if (filters.jobTypeId) definition.jobTypeId = filters.jobTypeId
  if (filters.state) definition.state = filters.state
  if (filters.status) definition.status = filters.status

  return definition
}

export type SegmentMembers = {
  members: Pick<ContactRow, 'id' | 'email' | 'first_name' | 'last_name'>[]
  total: number
  /** True when the segment matched more contacts than the cap allows. */
  truncated: boolean
}

/**
 * Resolves a segment definition to its current members.
 *
 * Selects only the fields a send actually needs — there is no reason to pull full
 * contact records into a fan-out loop.
 */
export async function resolveSegmentMembers(
  db: SupabaseClient<Database>,
  definition: unknown
): Promise<SegmentMembers> {
  const filters = {
    ...segmentDefinitionToFilters(definition),
    pageSize: SEGMENT_MEMBER_CAP,
    page: 1,
  }

  const query = db
    .from('active_contacts')
    .select('id, email, first_name, last_name', { count: 'exact' })

  const { data, error, count } = await (applyContactFilters(
    query as never,
    filters
  ) as unknown as PromiseLike<{
    data: SegmentMembers['members'] | null
    error: { message: string } | null
    count: number | null
  }>)

  if (error) {
    throw new Error(`Could not resolve segment members: ${error.message}`)
  }

  const total = count ?? data?.length ?? 0

  return {
    members: data ?? [],
    total,
    // Surfaced so a truncated send is never mistaken for a complete one.
    truncated: total > SEGMENT_MEMBER_CAP,
  }
}

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContactRow, Database } from '@/lib/db/types'

import {
  SORT_COLUMNS,
  buildSearchOrExpression,
  getPageRange,
  type ContactFilters,
} from './query'

/**
 * Contact reads and archival.
 *
 * Filters are applied server-side. The previous approach loaded every contact into the
 * browser and filtered in memory, which is why there was no pagination and no way to
 * export a filtered set.
 */

/**
 * Which relation to read from.
 *
 * The default path goes through `active_contacts`, a security_invoker view that already
 * excludes soft-deleted rows — so a forgotten `.is('deleted_at', null)` cannot leak
 * archived contacts. Only the archive screen reads the base table.
 */
export function contactSource(includeArchived: boolean): 'contacts' | 'active_contacts' {
  return includeArchived ? 'contacts' : 'active_contacts'
}

/** Minimal shape needed from a PostgREST query builder, so this stays unit-testable. */
type Filterable = {
  eq: (column: string, value: unknown) => Filterable
  is: (column: string, value: unknown) => Filterable
  not: (column: string, operator: string, value: unknown) => Filterable
  or: (expression: string) => Filterable
  order: (column: string, options: { ascending: boolean }) => Filterable
  range: (from: number, to: number) => Filterable
}

/** Applies filters, ordering and a bounded range to a contacts query. */
export function applyContactFilters<T extends Filterable>(query: T, filters: ContactFilters): T {
  let result: Filterable = query

  if (filters.includeArchived) {
    // The archive screen shows archived contacts *only*, not everything.
    result = result.not('deleted_at', 'is', null)
  }

  if (filters.jobTypeId) {
    result = result.eq('job_type_id', filters.jobTypeId)
  }

  if (filters.state) {
    result = result.eq('state', filters.state)
  }

  if (filters.status) {
    result = result.eq('status', filters.status)
  }

  if (filters.subscribed !== null) {
    result = result.eq('subscribed_to_newsletter', filters.subscribed)
  }

  if (filters.q) {
    const expression = buildSearchOrExpression(filters.q)
    if (expression) {
      result = result.or(expression)
    }
  }

  result = result.order(SORT_COLUMNS[filters.sort], { ascending: filters.dir === 'asc' })

  // Always bounded. An unbounded query is one bad filter away from loading the table.
  const { from, to } = getPageRange(filters)
  result = result.range(from, to)

  return result as T
}

export type ContactPage = {
  rows: ContactRow[]
  total: number
}

/** Fetches one page of contacts along with the total matching count. */
export async function fetchContacts(
  db: SupabaseClient<Database>,
  filters: ContactFilters
): Promise<ContactPage> {
  const select = '*, organisation:organisations(name), job_type:job_types(name)'

  // Branch rather than passing a union to .from(): supabase-js overloads on the
  // relation name, and a union satisfies neither overload.
  const query = filters.includeArchived
    ? db.from('contacts').select(select, { count: 'exact' })
    : db.from('active_contacts').select(select, { count: 'exact' })

  const { data, error, count } = await (applyContactFilters(
    query as unknown as Filterable,
    filters
  ) as unknown as PromiseLike<{
    data: ContactRow[] | null
    error: { message: string } | null
    count: number | null
  }>)

  if (error) {
    throw new Error(`Could not load contacts: ${error.message}`)
  }

  return { rows: data ?? [], total: count ?? 0 }
}

/**
 * Archives a contact.
 *
 * Soft delete: the row is retained with `deleted_at` set. Nothing in the UI performs a
 * hard delete — the client's requirement is that records are archived, not removed.
 *
 * Guarded with `deleted_at is null` so re-archiving does not overwrite the original
 * archive timestamp.
 */
export async function archiveContact(
  db: SupabaseClient<Database>,
  id: string
): Promise<void> {
  const { error } = await db
    .from('contacts')
    .update({ deleted_at: new Date().toISOString(), status: 'archived' })
    .eq('id', id)
    .is('deleted_at', null)

  if (error) {
    throw new Error(`Could not archive contact: ${error.message}`)
  }
}

/** Restores an archived contact. */
export async function restoreContact(
  db: SupabaseClient<Database>,
  id: string
): Promise<void> {
  const { error } = await db
    .from('contacts')
    .update({ deleted_at: null, status: 'prospect' })
    .eq('id', id)
    .not('deleted_at', 'is', null)

  if (error) {
    // contacts_email_active_idx only covers live rows, so restoring a contact whose
    // address was reused in the meantime violates it. Explain that rather than
    // surfacing a raw constraint error.
    if (error.code === '23505') {
      throw new Error(
        'There is already an active contact with that email address. ' +
          'Archive or update the other record first.'
      )
    }

    throw new Error(`Could not restore contact: ${error.message}`)
  }
}

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContactRow, Database } from '@/lib/db/types'

import {
  SEARCH_ORGANISATION_CAP,
  SORT_COLUMNS,
  buildSearchOrExpression,
  escapeLikePattern,
  getPageRange,
  type ContactFilters,
  type ContactSortKey,
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
  in: (column: string, values: readonly unknown[]) => Filterable
  or: (expression: string) => Filterable
  order: (column: string, options: { ascending: boolean }) => Filterable
  range: (from: number, to: number) => Filterable
}

export type ContactFilterOptions = {
  /**
   * Organisations whose name matched the search term.
   *
   * Resolved by the caller (see `findOrganisationIdsMatching`) because organisation is
   * a joined table rather than a column, and PostgREST cannot OR across an embedded
   * resource and its parent in one expression.
   */
  organisationIds?: readonly string[]
}

/** Raised instead of returning a silently truncated export. */
export class ContactExportLimitError extends Error {
  constructor(
    readonly total: number,
    readonly maxRows: number
  ) {
    super(`This export contains ${total} contacts; the safe limit is ${maxRows}. Narrow the filters and try again.`)
    this.name = 'ContactExportLimitError'
  }
}

/** Applies filters, ordering and a bounded range to a contacts query. */
export function applyContactFilters<T extends Filterable>(
  query: T,
  filters: ContactFilters,
  options: ContactFilterOptions = {}
): T {
  let result: Filterable = query

  if (filters.includeArchived) {
    // The archive screen shows archived contacts *only*, not everything — and never a
    // removed one, which is gone from the application for good.
    result = result.not('deleted_at', 'is', null).is('removed_at', null)
  }

  if (filters.ids !== null) {
    // An explicit selection narrows the set rather than replacing the filters, so a
    // selected row that no longer matches the current view is not exported behind the
    // user's back. An empty selection matches nothing, by design — see ContactFilters.
    result = result.in('id', filters.ids)
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

  if (filters.subscribedToPrograms !== null) {
    result = result.eq('subscribed_to_programs', filters.subscribedToPrograms)
  }

  if (filters.subscribed !== null) {
    result = result.eq('subscribed_to_newsletter', filters.subscribed)
  }

  if (filters.q) {
    const expression = buildSearchOrExpression(filters.q, options.organisationIds ?? [])
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

/**
 * Finds organisations whose name matches a search term.
 *
 * Searching by organisation is a stated requirement, and organisation lives on its own
 * table — so a single query cannot express it. This resolves the ids, and the caller
 * folds them into the contact filter. Bounded: see SEARCH_ORGANISATION_CAP.
 *
 * A failure here is swallowed on purpose. Organisation is one of several fields the
 * search covers, and losing it should narrow the results, not turn the whole search
 * into an error page.
 */
export async function findOrganisationIdsMatching(
  db: SupabaseClient<Database>,
  term: string
): Promise<string[]> {
  const trimmed = term.trim()

  if (trimmed === '') {
    return []
  }

  const { data, error } = await db
    .from('organisations')
    .select('id')
    .ilike('name', `%${escapeLikePattern(trimmed)}%`)
    .limit(SEARCH_ORGANISATION_CAP)

  if (error) {
    console.warn(`Organisation search skipped: ${error.message}`)
    return []
  }

  return (data ?? []).map((row) => row.id)
}

/** Fetches one page of contacts along with the total matching count. */
export async function fetchContacts(
  db: SupabaseClient<Database>,
  filters: ContactFilters
): Promise<ContactPage> {
  const select = '*, organisation:organisations(name), job_type:job_types(name)'

  // Resolved before the contact query so the ids can join the same `.or()` — a contact
  // matches if their own name, email or position matches, *or* their organisation did.
  const organisationIds = filters.q ? await findOrganisationIdsMatching(db, filters.q) : []

  // Branch rather than passing a union to .from(): supabase-js overloads on the
  // relation name, and a union satisfies neither overload.
  const query = filters.includeArchived
    ? db.from('contacts').select(select, { count: 'exact' })
    : db.from('active_contacts').select(select, { count: 'exact' })

  const { data, error, count } = await (applyContactFilters(
    query as unknown as Filterable,
    filters,
    { organisationIds }
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
 * Ids named in a single PostgREST request.
 *
 * A selection is applied as `id=in.(...)`, which travels in the URL — so the ids are
 * requested in chunks small enough that the request stays well inside the proxy's
 * header limit, rather than failing on length once a user selects enough rows.
 */
export const EXPORT_ID_CHUNK_SIZE = 200

/** Value a row sorts by for a given key, flattening the joins the DB sorts by id. */
function sortValue(row: JoinedRow, sort: ContactSortKey): string {
  switch (sort) {
    case 'organisation':
      // The database orders by organisation_id, which is meaningless to a reader. A
      // selection is re-ordered here anyway, so it sorts by the name that is exported.
      return row.organisation?.name ?? ''
    case 'status':
      return String(row.status ?? '')
    case 'newsletter':
      return row.subscribed_to_newsletter ? '1' : '0'
    case 'created':
      return String(row.created_at ?? '')
    case 'name':
    default:
      return `${row.last_name ?? ''} ${row.first_name ?? ''}`
  }
}

type JoinedRow = ContactRow & { organisation?: { name: string } | null }

/** Orders rows the way the active sort would, for a set assembled from several queries. */
export function sortSelectedRows<T extends ContactRow>(
  rows: T[],
  sort: ContactSortKey,
  dir: 'asc' | 'desc'
): T[] {
  const direction = dir === 'desc' ? -1 : 1

  // Copied rather than sorted in place: the caller's array is not ours to reorder.
  return [...rows].sort(
    (a, b) =>
      direction *
      sortValue(a as JoinedRow, sort).localeCompare(sortValue(b as JoinedRow, sort), undefined, {
        sensitivity: 'base',
      })
  )
}

/**
 * Loads an explicitly selected set of contacts, in bounded id chunks.
 *
 * The active filters still apply, so a row that has since been archived or filtered out
 * of the view is not exported. Fewer rows than ids is therefore an expected outcome, not
 * an error — unlike the filtered path, where a short read means a truncated export.
 */
export async function fetchSelectedContactsForExport(
  db: SupabaseClient<Database>,
  filters: ContactFilters,
  ids: readonly string[],
  maxRows: number,
  chunkSize = EXPORT_ID_CHUNK_SIZE
): Promise<ContactPage> {
  if (ids.length > maxRows) {
    throw new ContactExportLimitError(ids.length, maxRows)
  }

  const safeChunkSize = Math.max(1, chunkSize)
  const rows: ContactRow[] = []

  for (let start = 0; start < ids.length; start += safeChunkSize) {
    const chunk = ids.slice(start, start + safeChunkSize)
    const page = await fetchContacts(db, {
      ...filters,
      ids: [...chunk],
      page: 1,
      pageSize: chunk.length,
    })

    rows.push(...page.rows)
  }

  const ordered = sortSelectedRows(rows, filters.sort, filters.dir)

  return { rows: ordered, total: ordered.length }
}

/**
 * Loads a complete filtered set in bounded PostgREST pages.
 *
 * Supabase projects commonly cap each response at 1,000 rows even when a larger
 * range is requested. The total count is checked before continuing, and an empty
 * intermediate page is treated as an error so an export can never look complete
 * while containing only a prefix.
 */
export async function fetchContactsForExport(
  db: SupabaseClient<Database>,
  filters: ContactFilters,
  maxRows: number,
  pageSize = 1_000
): Promise<ContactPage> {
  if (filters.ids !== null) {
    return fetchSelectedContactsForExport(db, filters, filters.ids, maxRows)
  }

  const safePageSize = Math.max(1, Math.min(pageSize, maxRows))
  const rows: ContactRow[] = []
  let page = 1
  let total = 0

  do {
    const result = await fetchContacts(db, { ...filters, page, pageSize: safePageSize })
    total = result.total

    if (total > maxRows) {
      throw new ContactExportLimitError(total, maxRows)
    }

    if (result.rows.length === 0 && rows.length < total) {
      throw new Error(
        `Contact export stopped after ${rows.length} of ${total} rows. Narrow the filters and retry.`
      )
    }

    rows.push(...result.rows)
    page += 1
  } while (rows.length < total)

  return { rows, total }
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

/** Restores an archived contact. A removed one is final and is left alone. */
export async function restoreContact(
  db: SupabaseClient<Database>,
  id: string
): Promise<void> {
  const { error } = await db
    .from('contacts')
    .update({ deleted_at: null, status: 'prospect' })
    .eq('id', id)
    .not('deleted_at', 'is', null)
    .is('removed_at', null)

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

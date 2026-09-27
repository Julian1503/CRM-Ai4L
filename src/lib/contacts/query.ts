import type { ContactStatus } from '@/lib/db/types'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ParamInput,
  getPageRange as getRange,
  readPageParams,
  readParam,
  readTrimmed,
} from '@/lib/pagination'

/**
 * Contact list filtering, sorting and pagination.
 *
 * Everything the URL can express is parsed and validated here, then applied to the
 * Supabase query. Two things make this security-relevant rather than merely tidy:
 *
 * 1. `sort` maps to a column name and `status` to an enum value. Both are whitelisted,
 *    never passed through.
 * 2. The free-text term is embedded in a PostgREST `.or()` expression, which has its own
 *    comma-separated grammar. An unescaped term can inject additional filter clauses —
 *    `x,status.eq.archived` would otherwise widen the result set.
 */

export const CONTACT_SORT_KEYS = [
  'name',
  'organisation',
  'status',
  'newsletter',
  'programs',
  'created',
] as const
export type ContactSortKey = (typeof CONTACT_SORT_KEYS)[number]

const CONTACT_STATUSES: ContactStatus[] = ['lead', 'prospect', 'customer', 'archived']

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE }

/** Columns each sort key maps to. Keeps arbitrary column names out of `.order()`. */
export const SORT_COLUMNS: Record<ContactSortKey, string> = {
  name: 'last_name',
  organisation: 'organisation_id',
  status: 'status',
  newsletter: 'subscribed_to_newsletter',
  programs: 'subscribed_to_programs',
  created: 'created_at',
}

/**
 * Columns on `contacts` the free-text search covers.
 *
 * Organisation is searched too, but it lives on a joined table rather than here — see
 * `buildSearchOrExpression`. Phone numbers are deliberately excluded: they are stored
 * as typed, so a substring search over them matches on formatting as often as on the
 * number, and the client's data has none of them populated in any case.
 */
const SEARCH_COLUMNS = [
  'first_name',
  'last_name',
  'email',
  'mobile_number',
  'work_phone',
  'position',
] as const

export type ContactFilters = {
  q: string | null
  /**
   * An explicit selection of contact ids, or null when the caller named none.
   *
   * `null` and `[]` mean different things and must not be conflated: null is "no
   * selection, use the filters", while an empty array is "a selection that resolved to
   * nothing" and must export nothing. Collapsing the two would turn a selection of
   * three rows into an export of the whole filtered table.
   */
  ids: string[] | null
  jobTypeId: string | null
  state: string | null
  status: ContactStatus | null
  /** Newsletter consent. Named `subscribed` since before there was a second stream. */
  subscribed: boolean | null
  /** Course and training consent. Independent of `subscribed`. */
  subscribedToPrograms: boolean | null
  includeArchived: boolean
  sort: ContactSortKey
  dir: 'asc' | 'desc'
  page: number
  pageSize: number
}

function readBoolean(input: ParamInput, key: string): boolean | null {
  const value = readTrimmed(input, key)?.toLowerCase()

  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false

  // Anything else is unset, not false — a typo must not silently filter the list.
  return null
}

/**
 * Upper bound on how many contacts one request may name explicitly.
 *
 * Ids travel to PostgREST inside an `id=in.(...)` filter, which lives in the URL — so
 * an unbounded list is a request that fails on length. Reads are chunked below that
 * limit (see EXPORT_ID_CHUNK_SIZE); this cap bounds the whole selection.
 */
export const MAX_SELECTED_IDS = 2_000

/**
 * Shape an id must have to be interpolated into a PostgREST filter.
 *
 * Ids come from our own rows, but they arrive back over the wire, so anything that is
 * not a plain id shape is dropped rather than trusted — the same rule
 * `buildSearchOrExpression` applies to organisation ids.
 */
const CONTACT_ID_PATTERN = /^[0-9a-zA-Z-]{1,64}$/

/**
 * Parses an explicit contact selection from a comma-separated `ids` value.
 *
 * Returns null when the caller named no selection at all, and an array otherwise —
 * possibly empty, when every id was malformed. Duplicates are collapsed so a repeated
 * id cannot inflate the request.
 *
 * Deliberately does not truncate at MAX_SELECTED_IDS: silently dropping ids would export
 * fewer rows than the user selected without saying so. It stops one past the cap, which
 * bounds the work here while leaving the caller able to see the list is over the limit
 * and refuse.
 */
export function parseContactIds(value: string | null): string[] | null {
  if (value === null) return null

  const trimmed = value.trim()
  if (trimmed === '') return []

  const ids = new Set<string>()

  for (const part of trimmed.split(',')) {
    const id = part.trim()

    if (id !== '' && CONTACT_ID_PATTERN.test(id)) {
      ids.add(id)

      if (ids.size > MAX_SELECTED_IDS) break
    }
  }

  return [...ids]
}

export function parseContactFilters(input: ParamInput): ContactFilters {
  const status = readTrimmed(input, 'status') as ContactStatus | null
  const sort = readTrimmed(input, 'sort') as ContactSortKey | null
  const dir = readTrimmed(input, 'dir')
  const state = readTrimmed(input, 'state')

  return {
    q: readTrimmed(input, 'q'),
    // readTrimmed collapses an empty value to null, which would read as "no selection".
    // The raw param is used so `ids=` stays distinguishable from an absent `ids`.
    ids: parseContactIds(readParam(input, 'ids')),
    jobTypeId: readTrimmed(input, 'jobTypeId'),
    // State codes are canonical uppercase (NSW, VIC), so normalise rather than
    // forcing the caller to match case.
    state: state ? state.toUpperCase() : null,
    status: status && CONTACT_STATUSES.includes(status) ? status : null,
    subscribed: readBoolean(input, 'subscribed'),
    subscribedToPrograms: readBoolean(input, 'programs'),
    includeArchived: readBoolean(input, 'includeArchived') ?? false,
    sort: sort && CONTACT_SORT_KEYS.includes(sort) ? sort : 'name',
    dir: dir === 'desc' ? 'desc' : 'asc',
    ...readPageParams(input),
  }
}

/**
 * Escapes SQL LIKE metacharacters so a search term matches literally.
 *
 * Without this, a term of `%` matches every row, and `_` matches any single character.
 * The backslash is escaped first — doing it last would corrupt the escapes just added.
 */
export function escapeLikePattern(term: string): string {
  return term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/**
 * Quotes a value for embedding in a PostgREST filter expression.
 *
 * PostgREST accepts a double-quoted value, inside which the grammar's separators
 * (`,` `.` `(` `)`) lose their meaning. Backslash and quote are escaped so the value
 * cannot terminate its own quoting.
 */
export function quoteFilterValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Upper bound on how many organisations a search term may expand to.
 *
 * Organisation is not a column on `contacts`, so searching it means resolving matching
 * organisation ids first and adding them to the filter as `organisation_id.in.(...)`.
 * PostgREST filters travel in the URL, so an unbounded list of ids is a request that
 * fails on length rather than a slow one. A term matching more than this many
 * organisations is too broad to be a useful search anyway.
 */
export const SEARCH_ORGANISATION_CAP = 100

/**
 * Builds the `.or()` expression for a free-text search, or null when there is no term.
 *
 * `organisationIds` widens the search to contacts belonging to organisations whose name
 * matched. They are resolved by the caller because it takes a second query, and this
 * function is pure so the escaping can be tested without a database.
 *
 * Verified against live PostgREST (2026-08-22): a term crafted to close its own quote
 * and append `status.eq.archived` is accepted as a literal search string and matches 0
 * rows, where a successful injection would have returned the whole table. The escaping
 * below is what makes that true, not PostgREST's own parsing.
 */
export function buildSearchOrExpression(
  term: string,
  organisationIds: readonly string[] = []
): string | null {
  const trimmed = term.trim()

  if (trimmed === '') {
    return null
  }

  const pattern = quoteFilterValue(`%${escapeLikePattern(trimmed)}%`)
  const clauses = SEARCH_COLUMNS.map((column) => `${column}.ilike.${pattern}`)

  // Ids come from our own database, never from the user -- but they are still
  // interpolated into the PostgREST grammar, so anything that is not a plain id shape
  // is dropped rather than trusted.
  const safeIds = organisationIds
    .filter((id) => /^[0-9a-zA-Z-]+$/.test(id))
    .slice(0, SEARCH_ORGANISATION_CAP)

  if (safeIds.length > 0) {
    clauses.push(`organisation_id.in.(${safeIds.join(',')})`)
  }

  return clauses.join(',')
}

/** Serialises filters back to a query string, omitting defaults. */
export function contactFiltersToSearchParams(filters: ContactFilters): URLSearchParams {
  const params = new URLSearchParams()

  if (filters.q) params.set('q', filters.q)
  if (filters.ids !== null) params.set('ids', filters.ids.join(','))
  if (filters.jobTypeId) params.set('jobTypeId', filters.jobTypeId)
  if (filters.state) params.set('state', filters.state)
  if (filters.status) params.set('status', filters.status)
  if (filters.subscribed !== null) params.set('subscribed', String(filters.subscribed))
  if (filters.subscribedToPrograms !== null) {
    params.set('programs', String(filters.subscribedToPrograms))
  }
  if (filters.includeArchived) params.set('includeArchived', 'true')
  if (filters.sort !== 'name') params.set('sort', filters.sort)
  if (filters.dir !== 'asc') params.set('dir', filters.dir)
  if (filters.page !== 1) params.set('page', String(filters.page))
  if (filters.pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(filters.pageSize))

  return params
}

/** Inclusive row range for `.range()`, derived from page and pageSize. */
export function getPageRange(filters: ContactFilters): { from: number; to: number } {
  return getRange(filters)
}

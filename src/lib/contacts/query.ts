import type { ContactStatus } from '@/lib/db/types'

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

export const CONTACT_SORT_KEYS = ['name', 'organisation', 'status', 'newsletter', 'created'] as const
export type ContactSortKey = (typeof CONTACT_SORT_KEYS)[number]

const CONTACT_STATUSES: ContactStatus[] = ['lead', 'prospect', 'customer', 'archived']

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

/** Columns each sort key maps to. Keeps arbitrary column names out of `.order()`. */
export const SORT_COLUMNS: Record<ContactSortKey, string> = {
  name: 'last_name',
  organisation: 'organisation_id',
  status: 'status',
  newsletter: 'subscribed_to_newsletter',
  created: 'created_at',
}

/** Columns the free-text search covers. */
const SEARCH_COLUMNS = ['first_name', 'last_name', 'email'] as const

export type ContactFilters = {
  q: string | null
  jobTypeId: string | null
  state: string | null
  status: ContactStatus | null
  subscribed: boolean | null
  includeArchived: boolean
  sort: ContactSortKey
  dir: 'asc' | 'desc'
  page: number
  pageSize: number
}

type ParamInput = URLSearchParams | Record<string, string | string[] | undefined>

function readParam(input: ParamInput, key: string): string | null {
  if (input instanceof URLSearchParams) {
    return input.get(key)
  }

  const value = input[key]

  if (Array.isArray(value)) {
    // Next.js surfaces a repeated query param as an array. Take the first rather than
    // joining, which would produce a nonsense value like "NSW,VIC".
    return value[0] ?? null
  }

  return value ?? null
}

function readTrimmed(input: ParamInput, key: string): string | null {
  const value = readParam(input, key)
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function readBoolean(input: ParamInput, key: string): boolean | null {
  const value = readTrimmed(input, key)?.toLowerCase()

  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false

  // Anything else is unset, not false — a typo must not silently filter the list.
  return null
}

function readPositiveInt(input: ParamInput, key: string, fallback: number, max?: number): number {
  const raw = readTrimmed(input, key)
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback
  }

  return max === undefined ? parsed : Math.min(parsed, max)
}

export function parseContactFilters(input: ParamInput): ContactFilters {
  const status = readTrimmed(input, 'status') as ContactStatus | null
  const sort = readTrimmed(input, 'sort') as ContactSortKey | null
  const dir = readTrimmed(input, 'dir')
  const state = readTrimmed(input, 'state')

  return {
    q: readTrimmed(input, 'q'),
    jobTypeId: readTrimmed(input, 'jobTypeId'),
    // State codes are canonical uppercase (NSW, VIC), so normalise rather than
    // forcing the caller to match case.
    state: state ? state.toUpperCase() : null,
    status: status && CONTACT_STATUSES.includes(status) ? status : null,
    subscribed: readBoolean(input, 'subscribed'),
    includeArchived: readBoolean(input, 'includeArchived') ?? false,
    sort: sort && CONTACT_SORT_KEYS.includes(sort) ? sort : 'name',
    dir: dir === 'desc' ? 'desc' : 'asc',
    page: readPositiveInt(input, 'page', 1),
    pageSize: readPositiveInt(input, 'pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
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
function quoteFilterValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Builds the `.or()` expression for a free-text search, or null when there is no term.
 *
 * NOTE: the quoting behaviour is pinned by unit tests but has not been exercised
 * against a live PostgREST instance — no database was available. Worth confirming with
 * a term containing a comma and a quote once the Supabase project exists.
 */
export function buildSearchOrExpression(term: string): string | null {
  const trimmed = term.trim()

  if (trimmed === '') {
    return null
  }

  const pattern = quoteFilterValue(`%${escapeLikePattern(trimmed)}%`)

  return SEARCH_COLUMNS.map((column) => `${column}.ilike.${pattern}`).join(',')
}

/** Serialises filters back to a query string, omitting defaults. */
export function contactFiltersToSearchParams(filters: ContactFilters): URLSearchParams {
  const params = new URLSearchParams()

  if (filters.q) params.set('q', filters.q)
  if (filters.jobTypeId) params.set('jobTypeId', filters.jobTypeId)
  if (filters.state) params.set('state', filters.state)
  if (filters.status) params.set('status', filters.status)
  if (filters.subscribed !== null) params.set('subscribed', String(filters.subscribed))
  if (filters.includeArchived) params.set('includeArchived', 'true')
  if (filters.sort !== 'name') params.set('sort', filters.sort)
  if (filters.dir !== 'asc') params.set('dir', filters.dir)
  if (filters.page !== 1) params.set('page', String(filters.page))
  if (filters.pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(filters.pageSize))

  return params
}

/** Inclusive row range for `.range()`, derived from page and pageSize. */
export function getPageRange(filters: ContactFilters): { from: number; to: number } {
  const from = (filters.page - 1) * filters.pageSize

  return { from, to: from + filters.pageSize - 1 }
}

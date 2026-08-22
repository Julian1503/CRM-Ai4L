/**
 * Shared pagination parsing and metadata for list endpoints.
 *
 * Every list bounds its result set the same way, for a reason that is easy to miss:
 * PostgREST caps a request at 1000 rows on its own and reports no error when it does.
 * An unbounded query therefore does not fail loudly once a table outgrows that cap — it
 * quietly returns a prefix, and a UI built on it shows incomplete data while looking
 * perfectly healthy. Bounding every list here makes the limit explicit, and returning
 * `total` alongside the rows lets the caller see what it is not being shown.
 */

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

export type PageParams = {
  page: number
  pageSize: number
}

export type PageMeta = PageParams & {
  total: number
  pageCount: number
  hasMore: boolean
}

/** Query params as either a parsed URLSearchParams or Next's route-param record. */
export type ParamInput = URLSearchParams | Record<string, string | string[] | undefined>

export function readParam(input: ParamInput, key: string): string | null {
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

export function readTrimmed(input: ParamInput, key: string): string | null {
  const value = readParam(input, key)
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Reads a positive integer, falling back on anything unparseable.
 *
 * A junk value falls back rather than erroring: a stale bookmark with `?page=abc` should
 * show the first page, not a 400.
 */
export function readPositiveInt(
  input: ParamInput,
  key: string,
  fallback: number,
  max?: number
): number {
  const raw = readTrimmed(input, key)
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback
  }

  return max === undefined ? parsed : Math.min(parsed, max)
}

/** Parses `page` and `pageSize`, clamping both into a range a caller cannot escape. */
export function readPageParams(
  input: ParamInput,
  defaultPageSize: number = DEFAULT_PAGE_SIZE
): PageParams {
  return {
    page: readPositiveInt(input, 'page', 1),
    pageSize: readPositiveInt(input, 'pageSize', defaultPageSize, MAX_PAGE_SIZE),
  }
}

/** Inclusive row range for `.range()`, derived from page and pageSize. */
export function getPageRange(params: PageParams): { from: number; to: number } {
  const from = (params.page - 1) * params.pageSize

  return { from, to: from + params.pageSize - 1 }
}

/**
 * Builds the pagination envelope returned alongside a page of rows.
 *
 * `pageCount` is at least 1 so an empty list reads as "page 1 of 1" rather than the
 * nonsensical "page 1 of 0".
 */
export function buildPageMeta(params: PageParams, total: number): PageMeta {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0

  return {
    page: params.page,
    pageSize: params.pageSize,
    total: safeTotal,
    pageCount: Math.max(1, Math.ceil(safeTotal / params.pageSize)),
    hasMore: params.page * params.pageSize < safeTotal,
  }
}

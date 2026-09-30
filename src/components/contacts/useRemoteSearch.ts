'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Debounced, paginated search against one of the catalogue endpoints
 * (`/api/job-types`, `/api/tags`, `/api/organisations`).
 *
 * Every one of those answers `{ <items>, total, page, pageSize, hasMore }`, so the
 * pickers and settings cards share this instead of each re-implementing abort,
 * debounce and error handling. Options always come from the server: deriving them from
 * the contacts on screen would only ever offer what the current page happens to show.
 */

export const SEARCH_DEBOUNCE_MS = 250

export type RemoteSearchState<T> = {
  items: T[]
  total: number
  hasMore: boolean
  isLoading: boolean
  error: string | null
  /** Re-runs the current request, e.g. after a create or rename. */
  reload: () => void
}

type Options<T> = {
  /** Endpoint path, without query string. */
  url: string
  /** Search text; trimmed, and omitted from the request when empty. */
  query: string
  page?: number
  pageSize?: number
  /** Extra fixed params, e.g. `{ facet: 'industry' }`. */
  params?: Record<string, string>
  /** Pulls the item list out of the response body. */
  select: (body: Record<string, unknown>) => T[]
  /** When false nothing is fetched (e.g. a closed dropdown). */
  enabled?: boolean
  debounceMs?: number
}

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    if (delay <= 0) return

    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return delay <= 0 ? value : debounced
}

export async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown }

  return typeof body.error === 'string' && body.error ? body.error : `${fallback} (HTTP ${response.status})`
}

export function useRemoteSearch<T>({
  url,
  query,
  page = 1,
  pageSize = 20,
  params,
  select,
  enabled = true,
  debounceMs = SEARCH_DEBOUNCE_MS,
}: Options<T>): RemoteSearchState<T> {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const selectRef = useRef(select)
  useEffect(() => {
    selectRef.current = select
  }, [select])

  const term = useDebouncedValue(query.trim(), debounceMs)
  const paramsKey = params ? JSON.stringify(params) : ''

  useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()
    const search = new URLSearchParams(paramsKey ? (JSON.parse(paramsKey) as Record<string, string>) : {})

    if (term) search.set('q', term)
    search.set('page', String(page))
    search.set('pageSize', String(pageSize))

    const run = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const response = await fetch(`${url}?${search.toString()}`, { signal: controller.signal })

        if (!response.ok) throw new Error(await readErrorMessage(response, 'Could not load options'))

        const body = (await response.json()) as Record<string, unknown>
        const nextItems = selectRef.current(body)

        setItems(nextItems)
        setTotal(typeof body.total === 'number' ? body.total : nextItems.length)
        setHasMore(body.hasMore === true)
      } catch (caught) {
        if ((caught as Error).name === 'AbortError') return

        setItems([])
        setTotal(0)
        setHasMore(false)
        setError(caught instanceof Error ? caught.message : 'Could not load options.')
      } finally {
        if (!controller.signal.aborted) setIsLoading(false)
      }
    }

    void run()

    return () => controller.abort()
  }, [url, term, page, pageSize, paramsKey, enabled, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  return { items, total, hasMore, isLoading, error, reload }
}

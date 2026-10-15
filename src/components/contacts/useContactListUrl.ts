'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import {
  readContactListState,
  updateContactListState,
  writeContactListState,
  type ContactListState,
} from '@/lib/contacts/listUrlState'
import { useDebouncedValue } from '@/lib/contacts/useDebouncedValue'

/**
 * The contact list's view, held in the URL (UX plan P5.1, audit P2).
 *
 * Filters, sort and paging push a history entry, so Back undoes them. The search box
 * keeps its own text while typing and writes it to the URL once typing pauses (audit
 * M1), replacing the entry so each keystroke is not a step of history. When the URL
 * changes from outside (Back/Forward, a pasted link) the box follows it.
 */
export function useContactListUrl() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const state = useMemo(() => readContactListState(params), [params])

  const navigate = useCallback(
    (change: Partial<ContactListState>, mode: 'push' | 'replace' = 'push') => {
      const query = writeContactListState(updateContactListState(state, change)).toString()
      const url = query ? `${pathname}?${query}` : pathname
      if (mode === 'replace') router.replace(url, { scroll: false })
      else router.push(url, { scroll: false })
    },
    [state, pathname, router]
  )

  const [searchInput, setSearchInput] = useState(state.q)
  const debouncedSearch = useDebouncedValue(searchInput)

  // The latest URL value and navigate, read by the debounce effect below without making
  // it re-run on every URL change (which would write a stale search over Back/Forward).
  const latest = useRef({ q: state.q, navigate })
  const lastWritten = useRef(state.q)

  useEffect(() => {
    latest.current = { q: state.q, navigate }
    if (state.q !== lastWritten.current) {
      // The URL moved on its own: show what it says.
      lastWritten.current = state.q
      setSearchInput(state.q)
    }
  }, [state.q, navigate])

  useEffect(() => {
    const q = debouncedSearch.trim()
    if (q === latest.current.q) return
    lastWritten.current = q
    latest.current.navigate({ q }, 'replace')
  }, [debouncedSearch])

  return { state, navigate, searchInput, setSearchInput }
}

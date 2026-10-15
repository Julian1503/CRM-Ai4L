'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { TableContact } from '@/components/ContactTable'
import {
  fetchServicesForContacts,
  formatContactFromDatabase,
  getErrorMessage,
  type DbContact,
} from '@/lib/contacts/contactRows'
import { createLatestRequest, isAbortError } from '@/lib/contacts/latestRequest'
import { fetchContactStats, type ContactStats } from '@/lib/contacts/stats'
import { getSupabaseClient, hasSupabaseConfig } from '@/lib/supabaseClient'

/**
 * One page of contacts, filtered and sorted by the database through /api/contacts.
 *
 * Only the newest request may answer (audit M1): each load aborts the previous one and a
 * superseded response is dropped. A failed load keeps the last good page and reports the
 * error beside it (audit M2) rather than presenting it as "no contacts".
 */
export function useContactList(apiQuery: string, page: number, pageSize: number) {
  const [contacts, setContacts] = useState<TableContact[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requests = useRef(createLatestRequest())

  const reload = useCallback(async () => {
    if (!hasSupabaseConfig) {
      requests.current.cancel()
      setContacts([])
      setTotal(0)
      setIsLoading(false)
      return
    }

    const request = requests.current.begin()
    setIsLoading(true)

    try {
      const params = new URLSearchParams(apiQuery)
      params.set('page', String(page))
      params.set('pageSize', String(pageSize))

      const response = await fetch(`/api/contacts?${params.toString()}`, { signal: request.signal })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `Could not load contacts (HTTP ${response.status})`)
      }

      const body = await response.json()
      const rows = (body.contacts ?? []) as DbContact[]
      const servicesByContact = await fetchServicesForContacts(rows.map((row) => row.id))
      if (!request.isCurrent()) return

      setContacts(rows.map((row) => formatContactFromDatabase(row, servicesByContact.get(row.id) ?? [])))
      setTotal(body.total ?? 0)
      setError(null)
    } catch (caught) {
      if (!request.isCurrent() || isAbortError(caught)) return
      console.error('Failed to load contacts', caught)
      setError(`Could not load contacts: ${getErrorMessage(caught)}`)
    } finally {
      if (request.isCurrent()) setIsLoading(false)
    }
  }, [apiQuery, page, pageSize])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
  }, [reload])

  // Nothing may answer into an unmounted screen.
  useEffect(() => {
    const pending = requests.current
    return () => pending.cancel()
  }, [])

  return { contacts, total, isLoading, error, reload }
}

/**
 * The dashboard counters (definitions: src/lib/contacts/stats.ts). A failed count keeps
 * the last good figures and says so; before any count has succeeded, null (shown as a
 * dash, never as zero).
 */
export function useContactStats() {
  const [stats, setStats] = useState<ContactStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!hasSupabaseConfig) {
      setStats(null)
      return
    }
    try {
      setStats(await fetchContactStats(getSupabaseClient()))
      setError(null)
    } catch (caught) {
      console.error('Failed to load contact counts', caught)
      setError(getErrorMessage(caught))
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
  }, [reload])

  return { stats, error, reload }
}

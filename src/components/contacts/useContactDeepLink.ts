'use client'

import { useCallback, useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import type { TableContact } from '@/components/ContactTable'
import { useToast } from '@/components/ui/Toast'
import { fetchServicesForContacts, formatContactFromDatabase, getErrorMessage, type DbContact } from '@/lib/contacts/contactRows'
import { isUuid } from '@/lib/contacts/tags'

/** The search parameter that opens one contact's drawer: `/contacts?contact=<id>`. */
export const CONTACT_PARAM = 'contact'

/** The address that opens a contact's drawer on the contacts list. */
export function contactHref(contactId: string): string {
  return `/contacts?${CONTACT_PARAM}=${encodeURIComponent(contactId)}`
}

async function loadContact(id: string, signal: AbortSignal): Promise<TableContact | null> {
  // The list API with an explicit selection: the same columns, the same archive rules.
  const response = await fetch(`/api/contacts?ids=${encodeURIComponent(id)}&page=1&pageSize=1`, { signal })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  const row = (Array.isArray(body.contacts) ? body.contacts[0] : null) as DbContact | null
  if (!row) return null
  const services = await fetchServicesForContacts([row.id])
  return formatContactFromDatabase(row, services.get(row.id) ?? [])
}

/**
 * Opens the contact named by `?contact=<id>` (bookings and other workspaces link here),
 * and returns a close() that drops the parameter again. A malformed id is ignored; an
 * unknown or archived one is reported, never opened as an empty drawer.
 */
export function useContactDeepLink(open: (contact: TableContact) => void) {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const { notify } = useToast()
  const contactId = params.get(CONTACT_PARAM)
  const openRef = useRef(open)

  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    if (!contactId || !isUuid(contactId)) return
    const controller = new AbortController()
    loadContact(contactId, controller.signal)
      .then((contact) => {
        if (controller.signal.aborted) return
        if (contact) openRef.current(contact)
        else notify({ tone: 'error', message: 'That contact is not in the list. It may have been archived.' })
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        notify({ tone: 'error', message: `Could not open the contact: ${getErrorMessage(error)}` })
      })
    return () => controller.abort()
  }, [contactId, notify])

  return useCallback(() => {
    if (!contactId) return
    const next = new URLSearchParams(params.toString())
    next.delete(CONTACT_PARAM)
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [contactId, params, pathname, router])
}

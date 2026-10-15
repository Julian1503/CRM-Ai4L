import type { BookingStatusCounts } from '@/lib/booking/query'
import type { NeedsActionReason } from '@/lib/booking/needsAction'
import type { BookingStatus } from '@/lib/db/types'

/** One row of GET /api/bookings. */
export type BookingListItem = {
  id: string
  status: BookingStatus
  list_amount_cents: number
  charged_amount_cents: number | null
  currency: string
  scheduled_at: string | null
  created_at: string
  contact: { id: string; first_name: string; last_name: string; email: string } | null
  campaign: { id: string; name: string } | null
  reasons: NeedsActionReason[]
}

export type SchedulingHealth = { delayed: boolean; unmatchedEvents: number; failedDeliveries: number }

/** GET /api/bookings */
export type BookingListResponse = {
  bookings: BookingListItem[]
  counts: BookingStatusCounts
  needsActionCount: number
  schedulingHealth: SchedulingHealth | null
  total: number
}

/** Where "Open integration health" goes when the page does not say: Settings › Overview. */
export const INTEGRATION_HEALTH_HREF = '/settings?section=overview'

export function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function contactName(contact: BookingListItem['contact']): string {
  if (!contact) return 'Contact removed'
  return `${contact.first_name} ${contact.last_name}`.trim() || contact.email
}

/** Start of a local calendar day (YYYY-MM-DD) as an ISO instant; `endOfDay` gives the next day's start. */
export function localDayToIso(day: string, endOfDay = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const date = new Date(`${day}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  if (endOfDay) date.setDate(date.getDate() + 1)
  return date.toISOString()
}

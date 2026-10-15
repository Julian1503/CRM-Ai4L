import type { BookingStatus } from '@/lib/db/types'

import type { NeedsActionReason } from './needsAction'
import { formatAmountCents } from './query'

/**
 * One booking's history, for the bookings detail drawer (UX plan P4.2).
 *
 * Built only from facts the database records about this booking:
 *   - `bookings`: created, checkout opened (consumed_at), charged amount, appointment
 *     time, cancellation, expiry, and the Calendly invitees it was rescheduled away from;
 *   - `notification_outbox`: when the $0 claim was recorded (the confirmation email is
 *     queued in the same transaction as the payment) and what happened to that email;
 *   - `booking_reconciliation`: Calendly events that could not be applied on their own.
 * The webhook ledger (`webhook_events`) and `integration_deliveries` are not keyed by
 * booking, so they feed the list's "scheduling updates are delayed" signal instead.
 *
 * Pure, so the wording and ordering are testable without a database.
 */

export type BookingDetailRecord = {
  id: string
  status: BookingStatus
  created_at: string
  updated_at: string
  expires_at: string
  consumed_at: string | null
  stripe_session_id: string | null
  calendly_event_uri: string | null
  calendly_invitee_uri: string | null
  calendly_superseded_invitees: string[] | null
  scheduled_at: string | null
  cancelled_at: string | null
  list_amount_cents: number
  charged_amount_cents: number | null
  currency: string
  contact: { id: string; first_name: string; last_name: string; email: string } | null
  campaign: { id: string; name: string } | null
}

export type OutboxRecord = {
  id: string
  kind: string
  status: 'pending' | 'processing' | 'sent' | 'skipped' | 'failed'
  attempts: number
  last_error: string | null
  created_at: string
  sent_at: string | null
}

export type ReconciliationRecord = {
  id: string
  event_type: string
  reason: string
  scheduled_at: string | null
  created_at: string
  resolved_at: string | null
  resolution: string | null
}

export type TimelineTone = 'neutral' | 'success' | 'warning' | 'danger'

export type TimelineEntry = {
  key: string
  /** When it happened; null when the database does not record the moment. */
  at: string | null
  title: string
  detail?: string
  tone: TimelineTone
}

export type BookingDetail = {
  booking: BookingDetailRecord
  reasons: NeedsActionReason[]
  timeline: TimelineEntry[]
}

function formatWhen(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function emailEntries(outbox: OutboxRecord[]): TimelineEntry[] {
  return outbox.flatMap((note): TimelineEntry[] => {
    if (note.status === 'sent' && note.sent_at) {
      return [{ key: `email-${note.id}`, at: note.sent_at, title: 'Confirmation email sent', tone: 'success' }]
    }
    if (note.status === 'failed') {
      return [{
        key: `email-${note.id}`,
        at: null,
        title: 'Confirmation email failed',
        detail: note.last_error ?? `Gave up after ${note.attempts} attempts.`,
        tone: 'danger',
      }]
    }
    if (note.status === 'skipped') {
      return [{ key: `email-${note.id}`, at: null, title: 'Confirmation email not sent', detail: note.last_error ?? undefined, tone: 'warning' }]
    }
    return [{
      key: `email-${note.id}`,
      at: null,
      title: note.attempts > 0 ? 'Confirmation email retrying' : 'Confirmation email queued',
      detail: note.last_error ?? undefined,
      tone: 'neutral',
    }]
  })
}

function reconciliationEntries(rows: ReconciliationRecord[]): TimelineEntry[] {
  return rows.map((row) => ({
    key: `calendly-${row.id}`,
    at: row.created_at,
    title: row.resolved_at ? 'Calendly update matched later' : 'Calendly update not matched',
    detail: [
      row.event_type,
      row.scheduled_at ? `for ${formatWhen(row.scheduled_at)}` : null,
      row.resolved_at ? row.resolution : row.reason,
    ]
      .filter(Boolean)
      .join(' · '),
    tone: row.resolved_at ? 'neutral' : 'warning',
  }))
}

/** The booking's history, oldest first; events with no recorded time keep their place in the flow. */
export function buildBookingTimeline(
  booking: BookingDetailRecord,
  outbox: OutboxRecord[],
  reconciliation: ReconciliationRecord[],
  nowMs: number
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    {
      key: 'created',
      at: booking.created_at,
      title: 'Booking link sent',
      detail: booking.campaign ? `Campaign: ${booking.campaign.name}` : undefined,
      tone: 'neutral',
    },
  ]

  if (booking.consumed_at) {
    entries.push({ key: 'checkout', at: booking.consumed_at, title: 'Checkout opened', tone: 'neutral' })
  }

  const claim = outbox.find((note) => note.kind === 'booking_paid_confirmation')
  if (booking.charged_amount_cents !== null) {
    entries.push({
      key: 'claimed',
      // The claim and its email are written in one transaction, so the email's queue
      // time is the claim time. Without the email row the moment is not recorded.
      at: claim?.created_at ?? null,
      title: `Free offer claimed — ${formatAmountCents(booking.charged_amount_cents, booking.currency)} charged`,
      detail: `List price ${formatAmountCents(booking.list_amount_cents, booking.currency)}`,
      tone: 'success',
    })
  }

  entries.push(...emailEntries(outbox))

  const rescheduled = booking.calendly_superseded_invitees?.length ?? 0
  if (booking.scheduled_at && (booking.status === 'booked' || booking.status === 'cancelled')) {
    entries.push({
      key: 'scheduled',
      at: null,
      title: rescheduled > 0 ? 'Consultation rescheduled' : 'Consultation scheduled',
      detail: `For ${formatWhen(booking.scheduled_at)}${rescheduled > 0 ? ` · moved ${rescheduled} ${rescheduled === 1 ? 'time' : 'times'}` : ''}`,
      tone: 'success',
    })
  }

  entries.push(...reconciliationEntries(reconciliation))

  if (booking.cancelled_at) {
    entries.push({ key: 'cancelled', at: booking.cancelled_at, title: 'Consultation cancelled', tone: 'danger' })
  } else if (booking.status === 'expired' || (booking.status === 'pending' && new Date(booking.expires_at).getTime() < nowMs)) {
    entries.push({ key: 'expired', at: booking.expires_at, title: 'Booking link expired', tone: 'warning' })
  }

  return entries
}

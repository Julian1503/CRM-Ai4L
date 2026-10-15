import type { BookingStatus } from '@/lib/db/types'

/**
 * The "Needs action" rule for consultation bookings (UX plan P4.1).
 *
 * A booking needs a person when any of these holds:
 *
 *   1. `stalled_claim` — status `paid` (claimed at $0) and no time chosen for more than
 *      PAID_FOLLOW_UP_HOURS since the claim. Either the lead needs a nudge, or Calendly's
 *      `invitee.created` webhook did not arrive. `updated_at` is the claim time: nothing
 *      writes a `paid` booking again until it is scheduled or cancelled.
 *   2. `stalled_checkout` — status `checkout_started` for more than CHECKOUT_STALE_HOURS
 *      since the checkout was opened (`consumed_at`). The $0 checkout takes a minute; a
 *      lead still there hours later left half way.
 *   3. `unmatched_calendly` — an unresolved row in `booking_reconciliation` points at
 *      this booking (by its tracking id, or by the contact's email while the booking is
 *      waiting for a time or scheduled). Calendly reported something the database could
 *      not apply on its own.
 *   4. `email_failed` — the paid confirmation email in `notification_outbox` failed for
 *      good, so the lead may not have the scheduling link.
 *
 * Booked, cancelled and expired bookings only ever need action through rules 3 and 4.
 * The thresholds are product decisions; changing one here changes the list, the counts
 * and the reasons shown in the drawer together.
 */

export const PAID_FOLLOW_UP_HOURS = 24
export const CHECKOUT_STALE_HOURS = 2

const HOUR_MS = 60 * 60 * 1000

export const NEEDS_ACTION_REASONS = ['stalled_claim', 'stalled_checkout', 'unmatched_calendly', 'email_failed'] as const
export type NeedsActionReason = (typeof NEEDS_ACTION_REASONS)[number]

/** What the operator reads, and what to do about it. */
export const NEEDS_ACTION_LABELS: Record<NeedsActionReason, { label: string; hint: string }> = {
  stalled_claim: {
    label: 'No time chosen',
    hint: `Claimed more than ${PAID_FOLLOW_UP_HOURS} hours ago without picking a time. Follow up with the lead, and check scheduling updates if several are stuck here.`,
  },
  stalled_checkout: {
    label: 'Checkout not finished',
    hint: `Opened the $0 checkout more than ${CHECKOUT_STALE_HOURS} hours ago and did not finish it.`,
  },
  unmatched_calendly: {
    label: 'Calendly update not matched',
    hint: 'Calendly reported a booking change that could not be matched automatically. Check the appointment in Calendly.',
  },
  email_failed: {
    label: 'Confirmation email failed',
    hint: 'The email with the scheduling link could not be sent. Contact the lead directly.',
  },
}

export type NeedsActionCutoffs = {
  /** `paid` bookings last updated before this instant are stalled. */
  paidBefore: string
  /** `checkout_started` bookings opened before this instant are stalled. */
  checkoutBefore: string
}

export function needsActionCutoffs(nowMs: number): NeedsActionCutoffs {
  return {
    paidBefore: new Date(nowMs - PAID_FOLLOW_UP_HOURS * HOUR_MS).toISOString(),
    checkoutBefore: new Date(nowMs - CHECKOUT_STALE_HOURS * HOUR_MS).toISOString(),
  }
}

type ReasonInput = {
  id: string
  status: BookingStatus
  updated_at: string
  consumed_at: string | null
}

/** Bookings flagged by another table, resolved by the server before the list query. */
export type FlaggedBookings = {
  unmatchedCalendly: ReadonlySet<string>
  emailFailed: ReadonlySet<string>
}

/** Why one booking is in the queue; empty when it is not. Pure, so the rule is testable. */
export function needsActionReasons(booking: ReasonInput, cutoffs: NeedsActionCutoffs, flagged: FlaggedBookings): NeedsActionReason[] {
  const reasons: NeedsActionReason[] = []
  if (booking.status === 'paid' && booking.updated_at < cutoffs.paidBefore) reasons.push('stalled_claim')
  if (booking.status === 'checkout_started' && booking.consumed_at !== null && booking.consumed_at < cutoffs.checkoutBefore) {
    reasons.push('stalled_checkout')
  }
  if (flagged.unmatchedCalendly.has(booking.id)) reasons.push('unmatched_calendly')
  if (flagged.emailFailed.has(booking.id)) reasons.push('email_failed')
  return reasons
}

/** Ids interpolated into a PostgREST filter: only UUID-shaped values pass. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_FLAGGED_IDS = 200

export function safeIds(ids: Iterable<string>): string[] {
  return Array.from(new Set(ids)).filter((id) => ID_PATTERN.test(id)).slice(0, MAX_FLAGGED_IDS)
}

/**
 * The PostgREST `.or()` expression selecting the queue. The cutoffs are ISO strings we
 * generate and the ids are filtered to UUID shape, so nothing user-supplied is spliced in.
 */
export function needsActionOrExpression(cutoffs: NeedsActionCutoffs, flaggedIds: string[]): string {
  const clauses = [
    `and(status.eq.paid,updated_at.lt."${cutoffs.paidBefore}")`,
    `and(status.eq.checkout_started,consumed_at.lt."${cutoffs.checkoutBefore}")`,
  ]
  const ids = safeIds(flaggedIds)
  if (ids.length > 0) clauses.push(`id.in.(${ids.join(',')})`)
  return clauses.join(',')
}

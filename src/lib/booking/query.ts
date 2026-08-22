import type { BookingStatus } from '@/lib/db/types'
import {
  DEFAULT_PAGE_SIZE,
  type PageParams,
  type ParamInput,
  getPageRange as getRange,
  readPageParams,
  readTrimmed,
} from '@/lib/pagination'

/**
 * Booking list filtering and presentation.
 *
 * Split from `repository.ts` on purpose: that module is `server-only` because it
 * reaches the service-role client, and the bookings screen is a client component that
 * needs the labels and money formatting. Keeping the pure half here is what lets both
 * sides share one vocabulary instead of the UI re-deriving it from status strings.
 */

export const BOOKING_STATUSES: readonly BookingStatus[] = [
  'pending',
  'checkout_started',
  'paid',
  'booked',
  'cancelled',
  'expired',
] as const

export const BOOKING_SORT_KEYS = ['created', 'scheduled'] as const
export type BookingSortKey = (typeof BOOKING_SORT_KEYS)[number]

/** Columns each sort key maps to. Keeps arbitrary column names out of `.order()`. */
export const BOOKING_SORT_COLUMNS: Record<BookingSortKey, string> = {
  created: 'created_at',
  scheduled: 'scheduled_at',
}

export type BookingFilters = PageParams & {
  status: BookingStatus | null
  campaignId: string | null
  sort: BookingSortKey
  dir: 'asc' | 'desc'
}

export function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === 'string' && (BOOKING_STATUSES as readonly string[]).includes(value)
}

/**
 * Parses the booking list query string.
 *
 * `status` and `sort` are whitelisted rather than passed through — the same rule the
 * contact filters follow, and for the same reason: both reach a query builder.
 */
export function parseBookingFilters(input: ParamInput): BookingFilters {
  const status = readTrimmed(input, 'status')
  const sort = readTrimmed(input, 'sort')
  const dir = readTrimmed(input, 'dir')

  return {
    status: isBookingStatus(status) ? status : null,
    campaignId: readTrimmed(input, 'campaignId'),
    sort: sort && (BOOKING_SORT_KEYS as readonly string[]).includes(sort)
      ? (sort as BookingSortKey)
      : 'created',
    // Newest first: the operator's question is almost always "what just happened",
    // not "what happened when we started".
    dir: dir === 'asc' ? 'asc' : 'desc',
    ...readPageParams(input, DEFAULT_PAGE_SIZE),
  }
}

/** Inclusive row range for `.range()`. */
export function getBookingPageRange(filters: BookingFilters): { from: number; to: number } {
  return getRange(filters)
}

/**
 * What each status means to someone reading the screen.
 *
 * The enum values are engineering vocabulary — `checkout_started` tells an operator
 * nothing about whether they need to do something. These are what the table shows.
 */
export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  pending: 'Link sent',
  checkout_started: 'Claiming',
  paid: 'Awaiting a time',
  booked: 'Booked',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

/**
 * One line explaining where a booking actually is, for the operator.
 *
 * `paid` is the one worth spelling out: it means the lead accepted the offer and then
 * did not pick a slot — which is a follow-up, not a completed booking. It is also the
 * state everything sticks in if the Calendly webhook is not delivering, so naming it
 * plainly is what makes that failure visible rather than a silent stall.
 */
export const BOOKING_STATUS_HINTS: Record<BookingStatus, string> = {
  pending: 'The booking link has been emailed but not opened yet.',
  checkout_started: 'The lead opened the link and is going through checkout.',
  paid: 'Claimed at $0 but no time chosen yet — worth a follow-up.',
  booked: 'Consultation scheduled.',
  cancelled: 'The lead cancelled the appointment.',
  expired: 'The link expired before it was used.',
}

/** Statuses that represent a converted lead, for the headline count. */
export const CONVERTED_BOOKING_STATUSES: readonly BookingStatus[] = ['booked'] as const

export type BookingStatusCounts = Record<BookingStatus, number>

export function emptyBookingStatusCounts(): BookingStatusCounts {
  return {
    pending: 0,
    checkout_started: 0,
    paid: 0,
    booked: 0,
    cancelled: 0,
    expired: 0,
  }
}

/**
 * Formats a cent amount for display.
 *
 * Cents rather than dollars all the way to the edge, because the $500-to-$0 position is
 * the product's whole pitch and a rounding error in it is the kind of thing a client
 * notices immediately.
 */
export function formatAmountCents(cents: number | null, currency = 'AUD'): string {
  if (cents === null || !Number.isFinite(cents)) {
    return '—'
  }

  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: currency || 'AUD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

/**
 * True once Stripe has confirmed the checkout for this booking.
 *
 * `charged_amount_cents` is null until the webhook lands, so it — not the status alone —
 * is what says money (or the absence of it) has actually been settled.
 */
export function hasSettledPayment(booking: {
  charged_amount_cents: number | null
}): boolean {
  return booking.charged_amount_cents !== null
}

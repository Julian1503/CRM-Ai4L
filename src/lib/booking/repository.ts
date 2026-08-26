import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { BookingRow, BookingStatus, Database } from '@/lib/db/types'

import {
  BOOKING_SORT_COLUMNS,
  BOOKING_STATUSES,
  type BookingFilters,
  type BookingStatusCounts,
  emptyBookingStatusCounts,
  getBookingPageRange,
} from './query'
import {
  bookingExpiryFrom,
  generateBookingToken,
  hashBookingToken,
  isBookingUsable,
} from './token'

/**
 * Booking persistence.
 *
 * A booking is advanced by two independent webhooks (Stripe, then Calendly) that can
 * arrive out of order, more than once, or not at all. Every write here is therefore
 * conditional rather than assuming a sequence — a replayed event must be a no-op, not a
 * regression.
 */

export type BookingWithContact = BookingRow & {
  contact: {
    id: string
    email: string
    first_name: string
    last_name: string
  } | null
}

/** Mints a booking link for one campaign recipient. Returns the raw token for the URL. */
export async function createBooking(
  db: SupabaseClient<Database>,
  params: { contactId: string; campaignId?: string | null; nowMs?: number }
): Promise<{ token: string; bookingId: string }> {
  const nowMs = params.nowMs ?? Date.now()
  const { token, hash } = generateBookingToken()

  const { data, error } = await db
    .from('bookings')
    .insert({
      token_hash: hash,
      contact_id: params.contactId,
      campaign_id: params.campaignId ?? null,
      status: 'pending',
      expires_at: bookingExpiryFrom(nowMs),
    })
    .select('id')
    .single()

  if (error) {
    throw new Error(`Could not create booking: ${error.message}`)
  }

  return { token, bookingId: data!.id }
}

/** Looks a booking up by the raw token from the URL. */
export async function findBookingByToken(
  db: SupabaseClient<Database>,
  token: string
): Promise<BookingWithContact | null> {
  const { data, error } = await db
    .from('bookings')
    .select('*, contact:contacts(id, email, first_name, last_name)')
    .eq('token_hash', hashBookingToken(token))
    .maybeSingle()

  if (error) {
    throw new Error(`Could not load booking: ${error.message}`)
  }

  return (data as unknown as BookingWithContact) ?? null
}

export type BookingForDisplay = {
  booking: BookingWithContact | null
  usable: boolean
  reason: 'expired' | 'already_used' | 'cancelled' | 'not_found' | null
}

/**
 * Loads a booking and evaluates whether it can still be acted on.
 *
 * The time comparison lives here rather than in the page component: reading the clock
 * during render is an impure call, which the React Compiler rejects.
 */
export async function loadBookingForDisplay(
  db: SupabaseClient<Database>,
  token: string
): Promise<BookingForDisplay> {
  const booking = await findBookingByToken(db, token)

  if (!booking) {
    return { booking: null, usable: false, reason: 'not_found' }
  }

  const usability = isBookingUsable(booking, Date.now())

  return {
    booking,
    usable: usability.usable,
    reason: usability.usable ? null : usability.reason,
  }
}

/** Records that a Stripe Checkout session was opened for this booking. */
export async function markCheckoutStarted(
  db: SupabaseClient<Database>,
  bookingId: string,
  sessionId: string,
  promotionCodeId: string | null
): Promise<void> {
  const { error } = await db
    .from('bookings')
    .update({
      status: 'checkout_started',
      stripe_session_id: sessionId,
      stripe_promotion_code_id: promotionCodeId,
      // Consuming here, not on payment: the link has been acted on, so a forwarded
      // copy must not open a second checkout.
      consumed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId)
    .is('consumed_at', null)

  if (error) {
    throw new Error(`Could not start checkout: ${error.message}`)
  }
}

/**
 * Marks a booking paid from `checkout.session.completed`.
 *
 * Guarded so a replay cannot pull an already-booked row backwards into 'paid'.
 */
export async function markBookingPaid(
  db: SupabaseClient<Database>,
  sessionId: string,
  chargedAmountCents: number,
  bookingId?: string | null
): Promise<boolean> {
  let query = db
    .from('bookings')
    .update({
      status: 'paid',
      charged_amount_cents: chargedAmountCents,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_session_id', sessionId)
    .in('status', ['pending', 'checkout_started'])

  if (bookingId) {
    query = query.eq('id', bookingId)
  }

  const { data, error } = await query.select('id')

  if (error) {
    throw new Error(`Could not record payment: ${error.message}`)
  }

  return Boolean(data && data.length > 0)
}

/**
 * Attaches the scheduled Calendly event.
 *
 * Matched by booking id when the tracking parameter survived the redirect, and by
 * contact email otherwise — Calendly does not guarantee custom parameters come back.
 */
export async function markBookingScheduled(
  db: SupabaseClient<Database>,
  params: {
    bookingId?: string | null
    email?: string | null
    eventUri: string
    inviteeUri: string
    scheduledAt: string
  }
): Promise<boolean> {
  const updates = {
    status: 'booked' as const,
    calendly_event_uri: params.eventUri,
    calendly_invitee_uri: params.inviteeUri,
    scheduled_at: params.scheduledAt,
    updated_at: new Date().toISOString(),
  }

  if (params.bookingId) {
    const { data, error } = await db
      .from('bookings')
      .update(updates)
      .eq('id', params.bookingId)
      .in('status', ['paid', 'booked'])
      .select('id')

    if (error) throw new Error(`Could not record booking: ${error.message}`)
    return Boolean(data && data.length > 0)
  }

  if (!params.email) {
    return false
  }

  // Fall back to the most recent paid booking for that contact. Email matching is
  // necessarily weaker than the tracking id, so select one row first and update that
  // exact id rather than booking every pending offer for the same address.
  const { data: contact, error: contactError } = await db
    .from('contacts')
    .select('id')
    .eq('email', params.email.toLowerCase())
    .is('deleted_at', null)
    .maybeSingle()

  if (contactError) throw new Error(`Could not match invitee: ${contactError.message}`)
  if (!contact) return false

  const { data: booking, error: bookingError } = await db
    .from('bookings')
    .select('id')
    .eq('contact_id', contact.id)
    .in('status', ['paid', 'booked'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (bookingError) throw new Error(`Could not match booking: ${bookingError.message}`)
  if (!booking) return false

  const { data, error } = await db
    .from('bookings')
    .update(updates)
    .eq('id', booking.id)
    .in('status', ['paid', 'booked'])
    .select('id')

  if (error) throw new Error(`Could not record booking: ${error.message}`)

  return Boolean(data && data.length > 0)
}

/** Marks a booking cancelled from `invitee.canceled`. */
export async function markBookingCancelled(
  db: SupabaseClient<Database>,
  inviteeUri: string
): Promise<boolean> {
  const { data, error } = await db
    .from('bookings')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('calendly_invitee_uri', inviteeUri)
    .select('id')

  if (error) {
    throw new Error(`Could not cancel booking: ${error.message}`)
  }

  return Boolean(data && data.length > 0)
}

/** A booking joined to the people and campaign it belongs to, for the bookings screen. */
export type BookingListRow = BookingRow & {
  contact: { id: string; first_name: string; last_name: string; email: string } | null
  campaign: { id: string; name: string } | null
}

/**
 * One page of bookings for the operator-facing list.
 *
 * `token_hash` is deliberately excluded from the projection. It is only a hash, so it
 * opens nothing on its own -- but it is the credential's shadow, it has no reason to
 * reach a browser, and the cheapest way to keep it out of one is never to select it.
 */
export async function fetchBookings(
  db: SupabaseClient<Database>,
  filters: BookingFilters
): Promise<{ rows: BookingListRow[]; total: number }> {
  const range = getBookingPageRange(filters)

  let query = db
    .from('bookings')
    .select(
      'id, contact_id, campaign_id, status, expires_at, consumed_at, stripe_session_id, ' +
        'calendly_event_uri, scheduled_at, cancelled_at, list_amount_cents, ' +
        'charged_amount_cents, currency, created_at, updated_at, ' +
        'contact:contacts(id, first_name, last_name, email), campaign:campaigns(id, name)',
      { count: 'exact' }
    )

  if (filters.status) {
    query = query.eq('status', filters.status)
  }

  if (filters.campaignId) {
    query = query.eq('campaign_id', filters.campaignId)
  }

  const { data, error, count } = await query
    .order(BOOKING_SORT_COLUMNS[filters.sort], {
      ascending: filters.dir === 'asc',
      // A booking with no scheduled_at has not been scheduled; sorting those to the end
      // keeps the actual appointments at the top where they are being looked for.
      nullsFirst: false,
    })
    .range(range.from, range.to)

  if (error) {
    throw new Error(`Could not load bookings: ${error.message}`)
  }

  return {
    rows: (data ?? []) as unknown as BookingListRow[],
    total: count ?? 0,
  }
}

/**
 * How many bookings sit in each status.
 *
 * Counted rather than derived from the current page: the page is 50 rows of a funnel
 * whose whole point is the ratio between its stages, and a summary computed from one
 * page would silently describe that page instead of the funnel.
 *
 * One head-count per status, run in parallel and served by `bookings_status_idx`. A
 * `group by` would be one round trip instead of six, but PostgREST cannot express one
 * without a database view, and six indexed counts is not the bottleneck here.
 */
export async function countBookingsByStatus(
  db: SupabaseClient<Database>
): Promise<BookingStatusCounts> {
  const results = await Promise.all(
    BOOKING_STATUSES.map(async (status) => {
      const { count, error } = await db
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('status', status)

      if (error) {
        throw new Error(`Could not count bookings: ${error.message}`)
      }

      return [status, count ?? 0] as const
    })
  )

  const counts = emptyBookingStatusCounts()

  for (const [status, count] of results) {
    counts[status as BookingStatus] = count
  }

  return counts
}

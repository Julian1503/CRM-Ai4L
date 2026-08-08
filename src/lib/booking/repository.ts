import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { BookingRow, Database } from '@/lib/db/types'

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
  chargedAmountCents: number
): Promise<void> {
  const { error } = await db
    .from('bookings')
    .update({
      status: 'paid',
      charged_amount_cents: chargedAmountCents,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_session_id', sessionId)
    .in('status', ['pending', 'checkout_started'])

  if (error) {
    throw new Error(`Could not record payment: ${error.message}`)
  }
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
      .neq('status', 'cancelled')
      .select('id')

    if (error) throw new Error(`Could not record booking: ${error.message}`)
    if (data && data.length > 0) return true
  }

  if (!params.email) {
    return false
  }

  // Fall back to the most recent unscheduled booking for that contact.
  const { data: contact, error: contactError } = await db
    .from('contacts')
    .select('id')
    .eq('email', params.email.toLowerCase())
    .is('deleted_at', null)
    .maybeSingle()

  if (contactError) throw new Error(`Could not match invitee: ${contactError.message}`)
  if (!contact) return false

  const { data, error } = await db
    .from('bookings')
    .update(updates)
    .eq('contact_id', contact.id)
    .in('status', ['pending', 'checkout_started', 'paid'])
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

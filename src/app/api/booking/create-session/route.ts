import { NextResponse, type NextRequest } from 'next/server'

import { findBookingByToken, markCheckoutStarted } from '@/lib/booking/repository'
import { isBookingUsable } from '@/lib/booking/token'
import { createConsultationCheckout } from '@/lib/stripe/checkout'
import { getStripeClient, getStripeConfig } from '@/lib/stripe/client'
import { getAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Starts a Stripe Checkout session for a booking link.
 *
 * Public by necessity — the recipient is a lead, not a CRM user, so there is no session
 * to authenticate. The booking token is the credential: unguessable, single-use, and
 * expiring. It is checked before anything is created.
 *
 * Uses the service-role client because the caller is unauthenticated and RLS grants
 * them nothing.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let token = ''

  try {
    const body = await request.json()
    token = typeof body?.token === 'string' ? body.token : ''
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE })
  }

  if (!token) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: NO_STORE })
  }

  const stripeConfig = getStripeConfig()

  if (!stripeConfig) {
    return NextResponse.json(
      { error: 'Booking is temporarily unavailable.' },
      { status: 503, headers: NO_STORE }
    )
  }

  try {
    const db = getAdminClient()
    const booking = await findBookingByToken(db, token)

    // One message for every rejection: a distinct "expired" vs "not found" would let
    // someone probe for valid tokens.
    if (!booking) {
      return NextResponse.json(
        { error: 'This booking link is no longer valid.' },
        { status: 404, headers: NO_STORE }
      )
    }

    const usability = isBookingUsable(booking, Date.now())

    if (!usability.usable) {
      return NextResponse.json(
        { error: 'This booking link is no longer valid.', reason: usability.reason },
        { status: 410, headers: NO_STORE }
      )
    }

    if (!booking.contact?.email) {
      return NextResponse.json(
        { error: 'This booking link is no longer valid.' },
        { status: 410, headers: NO_STORE }
      )
    }

    const origin = request.nextUrl.origin
    const stripe = getStripeClient(stripeConfig.secretKey)

    const { sessionId, url } = await createConsultationCheckout(stripe, {
      priceId: stripeConfig.priceId,
      couponId: stripeConfig.couponId,
      bookingId: booking.id,
      email: booking.contact.email,
      successUrl: `${origin}/book/${token}/scheduled?session={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/book/${token}`,
    })

    // Recorded before redirecting, so a session always has a booking to attach to even
    // if the user abandons checkout.
    await markCheckoutStarted(db, booking.id, sessionId, null)

    return NextResponse.json({ url }, { headers: NO_STORE })
  } catch (error) {
    console.error('Booking checkout failed:', error)

    return NextResponse.json(
      { error: 'Could not start booking. Please try again.' },
      { status: 500, headers: NO_STORE }
    )
  }
}

import { NextResponse, type NextRequest } from 'next/server'
import type Stripe from 'stripe'

import { processNotifications } from '@/lib/booking/notifications'
import { applyCheckoutPayment, isCompletedCheckout } from '@/lib/booking/payment'
import {
  completeIntegrationDelivery,
  startIntegrationDelivery,
} from '@/lib/operations/deliveries'
import { getStripeClient, getStripeConfig } from '@/lib/stripe/client'
import { getAdminClient } from '@/lib/supabase/admin'
import { claimWebhookEvent, completeWebhookEvent } from '@/lib/webhooks/idempotency'

export const runtime = 'nodejs'

const PROVIDER = 'stripe'

/**
 * Stripe webhook.
 *
 * Signature verification uses `stripe.webhooks.constructEvent`, which needs the exact
 * bytes received — `request.text()`, never `request.json()`. Parsing and re-serialising
 * changes whitespace and key order, and the digest with it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const stripeConfig = getStripeConfig()

  if (!stripeConfig) {
    // Fail closed: with no secret configured there is no way to tell a real Stripe
    // callback from a forged one.
    console.warn('Stripe webhook rejected: not configured')
    return NextResponse.json({ error: 'Not configured.' }, { status: 401 })
  }

  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature.' }, { status: 401 })
  }

  const stripe = getStripeClient(stripeConfig.secretKey)
  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, stripeConfig.webhookSecret)
  } catch {
    // Terse on purpose — detail would help tune a forgery.
    console.warn('Stripe webhook rejected: invalid signature')
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 })
  }

  const db = getAdminClient()
  const deliveryId = await startIntegrationDelivery(db, PROVIDER, event.type)

  if (event.type !== 'checkout.session.completed') {
    // Acknowledge, so Stripe stops retrying an event we do not act on.
    await completeIntegrationDelivery(db, deliveryId, {
      status: 'succeeded',
      eventCount: 1,
      processedCount: 0,
      failedCount: 0,
    })
    return NextResponse.json({ status: 'ignored', type: event.type })
  }

  let claim: { provider: string; eventId: string; token: string } | null = null

  try {
    // Stripe retries aggressively. A completed event is acknowledged; one another
    // delivery is still working on is answered retryable; one whose worker died, or
    // that failed retryably, is taken over (audit H11).
    const claimed = await claimWebhookEvent(db, PROVIDER, event.id, event.type)

    if (claimed.outcome !== 'claimed') {
      await completeIntegrationDelivery(db, deliveryId, {
        status: 'succeeded',
        eventCount: 1,
        processedCount: claimed.outcome === 'completed' ? 1 : 0,
        failedCount: 0,
      })
      return claimed.outcome === 'completed'
        ? NextResponse.json({ status: 'duplicate' })
        : NextResponse.json({ status: 'in_progress' }, { status: 503 })
    }
    claim = { provider: PROVIDER, eventId: event.id, token: claimed.token }

    const session = event.data.object as Stripe.Checkout.Session
    const bookingId = session.metadata?.booking_id?.trim()

    if (!bookingId || !isCompletedCheckout(session)) {
      // Not something retrying can fix: record it terminally and acknowledge.
      await completeWebhookEvent(db, claim, 'failed_terminal', 'checkout not complete or no booking id')
      await completeIntegrationDelivery(db, deliveryId, {
        status: 'failed',
        eventCount: 1,
        processedCount: 0,
        failedCount: 1,
        errorCode: 'unexpected_checkout',
      })
      return NextResponse.json({ status: 'rejected' })
    }

    // Payment, confirmation email and event completion commit together (audit H10).
    const outcome = await applyCheckoutPayment(db, { bookingId, session, webhook: claim })

    if (outcome === 'not_ready') {
      throw new Error('The booking has not recorded this checkout yet.')
    }

    if (outcome === 'mismatch' || outcome === 'not_found') {
      console.warn('Stripe checkout refused', { bookingId, session: session.id, outcome })
      await completeIntegrationDelivery(db, deliveryId, {
        status: 'failed',
        eventCount: 1,
        processedCount: 0,
        failedCount: 1,
        errorCode: `checkout_${outcome}`,
      })
      return NextResponse.json({ status: 'rejected' })
    }

    // The email is queued; sending it now is only for immediacy. The scheduled worker
    // retries it independently of the payment if this attempt fails.
    await processNotifications(db, {
      retrieveCheckout: (id) => stripe.checkout.sessions.retrieve(id),
      limit: 1,
    }).catch((emailError) => {
      console.error('Booking confirmation email left queued', {
        bookingId,
        message: emailError instanceof Error ? emailError.message : String(emailError),
      })
    })

    await completeIntegrationDelivery(db, deliveryId, {
      status: 'succeeded',
      eventCount: 1,
      processedCount: 1,
      failedCount: 0,
    })

    return NextResponse.json({ status: outcome === 'applied' ? 'ok' : 'duplicate', session: session.id })
  } catch (error) {
    console.error('Stripe webhook processing failed:', error)

    if (claim) {
      await completeWebhookEvent(db, claim, 'failed_retryable', error instanceof Error ? error.message : 'failed')
    }

    await completeIntegrationDelivery(db, deliveryId, {
      status: 'failed',
      eventCount: 1,
      processedCount: 0,
      failedCount: 1,
      errorCode: 'processing_failed',
    })

    // 500 so Stripe retries; the ledger and the idempotent payment make that safe.
    return NextResponse.json({ error: 'Processing failed.' }, { status: 500 })
  }
}

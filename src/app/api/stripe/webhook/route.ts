import { NextResponse, type NextRequest } from 'next/server'
import type Stripe from 'stripe'

import { markBookingPaid } from '@/lib/booking/repository'
import {
  completeIntegrationDelivery,
  startIntegrationDelivery,
} from '@/lib/operations/deliveries'
import { getStripeClient, getStripeConfig } from '@/lib/stripe/client'
import { getAdminClient } from '@/lib/supabase/admin'
import { claimWebhookEvent, releaseWebhookEvent } from '@/lib/webhooks/idempotency'

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

  let claimed = false

  try {

    // Stripe retries aggressively; the ledger makes a replay a no-op.
    const isNew = await claimWebhookEvent(db, PROVIDER, event.id, event.type)

    if (!isNew) {
      await completeIntegrationDelivery(db, deliveryId, {
        status: 'succeeded',
        eventCount: 1,
        processedCount: 1,
        failedCount: 0,
      })
      return NextResponse.json({ status: 'duplicate' })
    }
    claimed = true

    const session = event.data.object as Stripe.Checkout.Session
    const bookingId = session.metadata?.booking_id?.trim()
    const paymentConfirmed =
      session.status === 'complete' &&
      (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')

    if (!bookingId || !paymentConfirmed || session.amount_total !== 0) {
      throw new Error('Checkout session did not confirm the expected $0 booking.')
    }

    const matched = await markBookingPaid(db, session.id, session.amount_total, bookingId)

    if (!matched) {
      throw new Error('Checkout session matched no pending booking.')
    }

    await completeIntegrationDelivery(db, deliveryId, {
      status: 'succeeded',
      eventCount: 1,
      processedCount: 1,
      failedCount: 0,
    })

    return NextResponse.json({ status: 'ok', session: session.id })
  } catch (error) {
    console.error('Stripe webhook processing failed:', error)

    if (claimed) {
      await releaseWebhookEvent(db, PROVIDER, event.id)
    }

    await completeIntegrationDelivery(db, deliveryId, {
      status: 'failed',
      eventCount: 1,
      processedCount: 0,
      failedCount: 1,
      errorCode: 'processing_failed',
    })

    // 500 so Stripe retries; the ledger makes that safe.
    return NextResponse.json({ error: 'Processing failed.' }, { status: 500 })
  }
}

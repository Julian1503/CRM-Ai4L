import { NextResponse, type NextRequest } from 'next/server'
import type Stripe from 'stripe'

import { markBookingPaid } from '@/lib/booking/repository'
import { getStripeClient, getStripeConfig } from '@/lib/stripe/client'
import { getAdminClient } from '@/lib/supabase/admin'
import { claimWebhookEvent } from '@/lib/webhooks/idempotency'

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

  if (event.type !== 'checkout.session.completed') {
    // Acknowledge, so Stripe stops retrying an event we do not act on.
    return NextResponse.json({ status: 'ignored', type: event.type })
  }

  try {
    const db = getAdminClient()

    // Stripe retries aggressively; the ledger makes a replay a no-op.
    const isNew = await claimWebhookEvent(db, PROVIDER, event.id, event.type)

    if (!isNew) {
      return NextResponse.json({ status: 'duplicate' })
    }

    const session = event.data.object as Stripe.Checkout.Session

    await markBookingPaid(db, session.id, session.amount_total ?? 0)

    return NextResponse.json({ status: 'ok', session: session.id })
  } catch (error) {
    console.error('Stripe webhook processing failed:', error)

    // 500 so Stripe retries; the ledger makes that safe.
    return NextResponse.json({ error: 'Processing failed.' }, { status: 500 })
  }
}

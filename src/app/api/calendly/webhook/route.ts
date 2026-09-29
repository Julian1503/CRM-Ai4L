import { NextResponse, type NextRequest } from 'next/server'

import { applyCalendlyEvent, readCalendlyEvent } from '@/lib/booking/calendly'
import {
  completeIntegrationDelivery,
  startIntegrationDelivery,
} from '@/lib/operations/deliveries'
import { getAdminClient } from '@/lib/supabase/admin'
import { claimWebhookEvent, completeWebhookEvent, deriveEventId } from '@/lib/webhooks/idempotency'
import { verifyWebhookSignature } from '@/lib/webhooks/verify'

export const runtime = 'nodejs'

const PROVIDER = 'calendly'

/**
 * Calendly webhook: invitee.created and invitee.canceled.
 *
 * Calendly signs with `Calendly-Webhook-Signature: t=<unix>,v1=<hmac-sha256 of
 * "timestamp.body">` — the same scheme already implemented in lib/webhooks/verify.ts,
 * so that verifier is reused rather than duplicated.
 *
 * NOTE: Calendly webhooks require a paid plan (Standard or above). Without one, no
 * event ever arrives and bookings will never reach 'booked' — the CRM would show them
 * stuck at 'paid'. Flagged in PLAN.md.
 */
type CalendlyPayload = {
  event?: string
  payload?: Record<string, unknown>
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text()
  const secret = process.env.CALENDLY_WEBHOOK_SECRET?.trim() ?? ''

  const verification = verifyWebhookSignature({
    rawBody,
    signatureHeader: request.headers.get('calendly-webhook-signature'),
    secret,
    nowSeconds: Math.floor(Date.now() / 1000),
  })

  if (!verification.valid) {
    console.warn(`Calendly webhook rejected: ${verification.reason}`)
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 })
  }

  const db = getAdminClient()
  const deliveryId = await startIntegrationDelivery(db, PROVIDER)

  let body: CalendlyPayload

  try {
    body = JSON.parse(rawBody)
  } catch {
    await completeIntegrationDelivery(db, deliveryId, {
      status: 'failed',
      eventCount: 0,
      processedCount: 0,
      failedCount: 0,
      errorCode: 'malformed_json',
    })
    return NextResponse.json({ error: 'Malformed JSON body.' }, { status: 400 })
  }

  const eventName = body.event

  if (eventName !== 'invitee.created' && eventName !== 'invitee.canceled') {
    await completeIntegrationDelivery(db, deliveryId, {
      status: 'succeeded',
      eventCount: 1,
      processedCount: 0,
      failedCount: 0,
    })
    return NextResponse.json({ status: 'ignored', event: eventName ?? null })
  }

  const invitee = readCalendlyEvent(eventName, body.payload)

  if (!invitee) {
    await completeIntegrationDelivery(db, deliveryId, {
      status: 'failed',
      eventCount: 1,
      processedCount: 0,
      failedCount: 1,
      errorCode: 'invalid_payload',
    })
    return NextResponse.json({ error: 'Invalid webhook payload.' }, { status: 400 })
  }

  const eventId = deriveEventId(rawBody, request.headers.get('calendly-webhook-id'))
  let claim: { provider: string; eventId: string; token: string } | null = null

  try {
    const claimed = await claimWebhookEvent(db, PROVIDER, eventId, eventName)

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
    claim = { provider: PROVIDER, eventId, token: claimed.token }

    // Applied and completed in one transaction (audit H11). Order-tolerant: a
    // reschedule's cancel and create may arrive either way round, twice (audit M4).
    // Anything that cannot be placed is parked for reconciliation, not dropped.
    const outcome = await applyCalendlyEvent(db, invitee, claim)

    await completeIntegrationDelivery(db, deliveryId, {
      status: 'succeeded',
      eventCount: 1,
      processedCount: 1,
      failedCount: 0,
    })

    return NextResponse.json({ status: outcome === 'applied' ? 'ok' : outcome })
  } catch (error) {
    console.error('Calendly webhook processing failed:', error)

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

    return NextResponse.json({ error: 'Processing failed.' }, { status: 500 })
  }
}

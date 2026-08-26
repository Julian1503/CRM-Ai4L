import { NextResponse, type NextRequest } from 'next/server'

import { markBookingCancelled, markBookingScheduled } from '@/lib/booking/repository'
import {
  completeIntegrationDelivery,
  startIntegrationDelivery,
} from '@/lib/operations/deliveries'
import { getAdminClient } from '@/lib/supabase/admin'
import { claimWebhookEvent, deriveEventId, releaseWebhookEvent } from '@/lib/webhooks/idempotency'
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
  payload?: {
    uri?: string
    email?: string
    scheduled_event?: { uri?: string; start_time?: string }
    tracking?: Record<string, unknown>
    questions_and_answers?: unknown
  }
}

/** Reads the booking id Calendly echoes back, if the tracking parameter survived. */
function readBookingId(payload: CalendlyPayload['payload']): string | null {
  const tracking = payload?.tracking

  if (typeof tracking !== 'object' || tracking === null) {
    return null
  }

  // Calendly surfaces `?utm_content=` and friends under `tracking`.
  const candidate = (tracking as Record<string, unknown>).utm_content

  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : null
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
  const payload = body.payload

  if (eventName !== 'invitee.created' && eventName !== 'invitee.canceled') {
    await completeIntegrationDelivery(db, deliveryId, {
      status: 'succeeded',
      eventCount: 1,
      processedCount: 0,
      failedCount: 0,
    })
    return NextResponse.json({ status: 'ignored', event: eventName ?? null })
  }

  const inviteeUri = payload?.uri

  if (!inviteeUri) {
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
  let claimed = false

  try {
    const isNew = await claimWebhookEvent(db, PROVIDER, eventId, eventName)

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

    if (eventName === 'invitee.canceled') {
      const cancelled = await markBookingCancelled(db, inviteeUri)

      await completeIntegrationDelivery(db, deliveryId, {
        status: 'succeeded',
        eventCount: 1,
        processedCount: 1,
        failedCount: 0,
      })

      return NextResponse.json({ status: cancelled ? 'ok' : 'unmatched' })
    }

    const matched = await markBookingScheduled(db, {
      bookingId: readBookingId(payload),
      email: payload?.email ?? null,
      eventUri: payload?.scheduled_event?.uri ?? '',
      inviteeUri,
      scheduledAt: payload?.scheduled_event?.start_time ?? new Date().toISOString(),
    })

    // An unmatched booking is acknowledged, not retried: the invitee may simply not be
    // in the CRM. Logged so it is visible rather than silently dropped.
    if (!matched) {
      await db.from('sync_logs').insert({
        event_text: `Calendly booking for ${payload?.email ?? 'unknown'} matched no contact`,
        status: 'info',
      })
    }

    await completeIntegrationDelivery(db, deliveryId, {
      status: 'succeeded',
      eventCount: 1,
      processedCount: 1,
      failedCount: 0,
    })

    return NextResponse.json({ status: matched ? 'ok' : 'unmatched' })
  } catch (error) {
    console.error('Calendly webhook processing failed:', error)

    if (claimed) {
      await releaseWebhookEvent(db, PROVIDER, eventId)
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

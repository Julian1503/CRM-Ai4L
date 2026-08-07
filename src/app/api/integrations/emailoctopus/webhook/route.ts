import { NextResponse, type NextRequest } from 'next/server'

import { applyNewsletterEvent, parseNewsletterEvent } from '@/lib/contacts/newsletter'
import { getAdminClient } from '@/lib/supabase/admin'
import { claimWebhookEvent, deriveEventId } from '@/lib/webhooks/idempotency'
import { verifyWebhookSignature } from '@/lib/webhooks/verify'

export const runtime = 'nodejs'

const PROVIDER = 'emailoctopus'

/**
 * EmailOctopus subscribe / unsubscribe webhook.
 *
 * Runs outside the session gate (see WEBHOOK_PATHS in src/lib/auth/routes.ts), so the
 * HMAC signature is the only authentication. It writes with the service-role client,
 * which bypasses Row Level Security — that combination is exactly why the signature
 * check is not optional.
 *
 * Header name and signature encoding still need confirming against the EmailOctopus
 * documentation; see src/lib/webhooks/verify.ts.
 */
const SIGNATURE_HEADERS = ['x-emailoctopus-signature', 'x-hub-signature-256', 'x-signature']
const EVENT_ID_HEADERS = ['x-emailoctopus-delivery', 'x-request-id', 'x-webhook-id']

function readFirstHeader(request: NextRequest, names: string[]): string | null {
  for (const name of names) {
    const value = request.headers.get(name)
    if (value) return value
  }

  return null
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // The signature covers the exact bytes sent. Parsing to JSON first and
  // re-serialising changes whitespace and key order, which changes the digest.
  const rawBody = await request.text()

  const secret = process.env.EMAILOCTOPUS_WEBHOOK_SECRET?.trim() ?? ''

  const verification = verifyWebhookSignature({
    rawBody,
    signatureHeader: readFirstHeader(request, SIGNATURE_HEADERS),
    secret,
    nowSeconds: Math.floor(Date.now() / 1000),
  })

  if (!verification.valid) {
    // Deliberately terse: a detailed reason would help an attacker tune their forgery.
    console.warn(`EmailOctopus webhook rejected: ${verification.reason}`)

    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body.' }, { status: 400 })
  }

  const parsed = parseNewsletterEvent(payload)

  if (!parsed.ok) {
    if (parsed.reason === 'ignored') {
      // Acknowledge: a 4xx would make the provider retry an event we will never handle.
      return NextResponse.json({ status: 'ignored' })
    }

    return NextResponse.json({ error: 'Invalid webhook payload.' }, { status: 400 })
  }

  const event = parsed.event

  try {
    const db = getAdminClient()

    const eventId = deriveEventId(rawBody, readFirstHeader(request, EVENT_ID_HEADERS))
    const isNew = await claimWebhookEvent(db, PROVIDER, eventId, event.type)

    if (!isNew) {
      // Already processed. Answer 200 so the provider stops retrying.
      return NextResponse.json({ status: 'duplicate', email: event.email })
    }

    const result = await applyNewsletterEvent(db, event)

    const summary =
      result.action === 'created'
        ? `Newsletter signup added ${event.email} as a new lead`
        : result.action === 'updated'
          ? `Newsletter ${event.type} applied to ${event.email}`
          : `Newsletter ${event.type} for ${event.email} matched no contact`

    const note = result.archivedMatchExists
      ? `${summary} (an archived contact shares this address and was left untouched)`
      : summary

    await db
      .from('sync_logs')
      .insert({ event_text: note, status: result.action === 'noop' ? 'info' : 'success' })

    return NextResponse.json({
      status: 'ok',
      action: result.action,
      email: event.email,
    })
  } catch (error) {
    console.error('EmailOctopus webhook processing failed:', error)

    // 500 so the provider retries — the idempotency ledger makes that safe.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Webhook processing failed.' },
      { status: 500 }
    )
  }
}

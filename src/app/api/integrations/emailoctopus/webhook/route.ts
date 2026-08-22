import { NextResponse, type NextRequest } from 'next/server'

import {
  applyNewsletterEvent,
  parseNewsletterBatch,
  type NewsletterEvent,
} from '@/lib/contacts/newsletter'
import { getAdminClient } from '@/lib/supabase/admin'
import {
  claimWebhookEvent,
  deriveEventId,
  releaseWebhookEvent,
} from '@/lib/webhooks/idempotency'
import { verifyWebhookSignature } from '@/lib/webhooks/verify'

export const runtime = 'nodejs'

const PROVIDER = 'emailoctopus'

/**
 * EmailOctopus contact webhook.
 *
 * Runs outside the session gate (see WEBHOOK_PATHS in src/lib/auth/routes.ts), so the
 * HMAC signature is the only authentication. It writes with the service-role client,
 * which bypasses Row Level Security — that combination is exactly why the signature
 * check is not optional.
 *
 * A delivery carries an array of up to 1000 events, buffered over roughly a minute.
 * Each is claimed in the idempotency ledger on its own; see
 * https://help.emailoctopus.com/article/314-webhooks
 */

/**
 * Sent as `EmailOctopus-Signature`. Header lookup is case-insensitive, and the value is
 * `sha256=<hex hmac of the raw body>` — the scheme verifyWebhookSignature already
 * implements. The previous `x-emailoctopus-signature` guess matched nothing, so every
 * delivery was answered with a 401.
 */
const SIGNATURE_HEADER = 'emailoctopus-signature'

type Counts = {
  created: number
  updated: number
  noop: number
  duplicate: number
}

async function processEvent(
  db: ReturnType<typeof getAdminClient>,
  event: NewsletterEvent,
  counts: Counts,
  notes: string[]
): Promise<void> {
  // Re-serialising the parsed event only produces the fallback key; the provider's own
  // event id is used whenever it is present.
  const eventId = deriveEventId(JSON.stringify(event), event.id)

  let claimed = false

  try {
    claimed = await claimWebhookEvent(db, PROVIDER, eventId, event.providerType)

    if (!claimed) {
      counts.duplicate += 1
      return
    }

    const result = await applyNewsletterEvent(db, event)
    counts[result.action] += 1

    const summary =
      result.action === 'created'
        ? `Newsletter signup added ${event.email} as a new lead`
        : result.action === 'updated'
          ? `Newsletter ${event.type} applied to ${event.email}`
          : `Newsletter ${event.type} for ${event.email} matched no contact`

    notes.push(
      result.archivedMatchExists
        ? `${summary} (an archived contact shares this address and was left untouched)`
        : summary
    )
  } catch (error) {
    if (claimed) {
      await releaseWebhookEvent(db, PROVIDER, eventId)
    }

    throw error
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // The signature covers the exact bytes sent. Parsing to JSON first and
  // re-serialising changes whitespace and key order, which changes the digest.
  const rawBody = await request.text()

  const secret = process.env.EMAILOCTOPUS_WEBHOOK_SECRET?.trim() ?? ''

  const verification = verifyWebhookSignature({
    rawBody,
    signatureHeader: request.headers.get(SIGNATURE_HEADER),
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

  const batch = parseNewsletterBatch(payload)

  if (!batch) {
    return NextResponse.json({ error: 'Invalid webhook payload.' }, { status: 400 })
  }

  if (batch.invalid > 0) {
    // Not fatal: see parseNewsletterBatch. Logged so bad rows stay visible.
    console.warn(`EmailOctopus webhook: skipped ${batch.invalid} malformed event(s)`)
  }

  const summary = {
    received: batch.events.length + batch.ignored + batch.invalid,
    ignored: batch.ignored,
    invalid: batch.invalid,
  }

  const counts: Counts = { created: 0, updated: 0, noop: 0, duplicate: 0 }

  // Nothing actionable — answer without opening a database connection.
  if (batch.events.length === 0) {
    return NextResponse.json({ status: 'ok', ...summary, ...counts })
  }

  const notes: string[] = []
  const failures: string[] = []

  const db = getAdminClient()

  // Sequential on purpose: two events for the same address in one batch must not race.
  for (const event of batch.events) {
    try {
      await processEvent(db, event, counts, notes)
    } catch (error) {
      failures.push(`${event.email}: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  if (notes.length > 0) {
    // One insert for the whole batch — a 1000-event delivery must not become 1000 round
    // trips. A logging failure must not fail the delivery itself.
    const { error: logError } = await db
      .from('sync_logs')
      .insert(notes.map((note) => ({ event_text: note, status: 'success' })))

    if (logError) {
      console.error(`EmailOctopus webhook: sync log write failed: ${logError.message}`)
    }
  }

  if (failures.length > 0) {
    console.error(`EmailOctopus webhook processing failed: ${failures.join('; ')}`)

    // 500 so the provider retries. The ledger skips what already succeeded, and the
    // failed events released their claims, so a retry reprocesses exactly those.
    return NextResponse.json(
      { error: 'Webhook processing failed.', failed: failures.length, ...counts, ...summary },
      { status: 500 }
    )
  }

  return NextResponse.json({ status: 'ok', ...summary, ...counts })
}

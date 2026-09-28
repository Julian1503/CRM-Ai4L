import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * Automated newsletter intake (scope 3.2).
 *
 * The shapes here follow the documented EmailOctopus webhook contract
 * (https://help.emailoctopus.com/article/314-webhooks): a request body is an **array**
 * of flat event objects, buffered for about a minute and capped at 1000 events per
 * delivery.
 *
 * An earlier version parsed a single `{ event, contact: { email_address } }` object and
 * mapped the types `contact.subscribed` / `contact.unsubscribed`. Neither that envelope
 * nor `contact.subscribed` exists, so every real delivery was rejected with a 400 and
 * retried for ten days. The fixtures that made those tests pass were hand-written.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type NewsletterEvent = {
  /** Provider event id — the idempotency key. Null when the payload omits it. */
  id: string | null
  /** The provider's own event name, recorded in the ledger to make deliveries traceable. */
  providerType: string
  type: 'subscribed' | 'unsubscribed'
  email: string
  firstName: string
  lastName: string
  externalId: string | null
  /** ISO 8601 instant the event occurred. Orders a batch; null when absent. */
  occurredAt: string | null
}

export type ParseResult =
  | { ok: true; event: NewsletterEvent }
  | { ok: false; reason: 'invalid' | 'ignored' }

/**
 * The event types this CRM acts on.
 *
 * `contact.clicked`, `contact.opened`, `contact.bounced` and `contact.complained` are
 * engagement signals with nowhere to go in the schema yet, so they are acknowledged and
 * dropped rather than rejected.
 */
const HANDLED_TYPES = new Set([
  'contact.created',
  'contact.updated',
  'contact.unsubscribed',
  'contact.deleted',
])

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Works out what an event means for the contact's consent.
 *
 * @returns null when the event carries no usable subscription state.
 */
function deriveType(providerType: string, status: string): NewsletterEvent['type'] | null {
  // Removal from the list is not a CRM deletion — it only ends the subscription.
  if (providerType === 'contact.unsubscribed' || providerType === 'contact.deleted') {
    return 'unsubscribed'
  }

  if (status === 'subscribed') return 'subscribed'
  if (status === 'unsubscribed') return 'unsubscribed'

  // A pending double opt-in has not been confirmed. Recording it as a subscriber would
  // claim consent the contact has not actually given.
  if (status === 'pending') return null

  // `contact_status` is documented as optional. A creation with no status is a new list
  // member; an update with no status says nothing about subscription state.
  return providerType === 'contact.created' ? 'subscribed' : null
}

/** Validates and normalises one event from an EmailOctopus delivery. */
export function parseNewsletterEvent(payload: unknown): ParseResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid' }
  }

  const body = payload as Record<string, unknown>
  const providerType = readString(body.type)

  if (!providerType) {
    return { ok: false, reason: 'invalid' }
  }

  // Unknown-but-well-formed events are acknowledged, not rejected — a 4xx would make
  // the provider retry something we will never handle.
  if (!HANDLED_TYPES.has(providerType)) {
    return { ok: false, reason: 'ignored' }
  }

  const email = readString(body.contact_email_address).toLowerCase()

  if (!email || !EMAIL_REGEX.test(email)) {
    return { ok: false, reason: 'invalid' }
  }

  const type = deriveType(providerType, readString(body.contact_status).toLowerCase())

  if (!type) {
    return { ok: false, reason: 'ignored' }
  }

  const fields = readRecord(body.contact_fields)

  return {
    ok: true,
    event: {
      id: readString(body.id) || null,
      providerType,
      type,
      email,
      firstName: readString(fields.FirstName),
      lastName: readString(fields.LastName),
      externalId: readString(body.contact_id) || null,
      occurredAt: readString(body.occurred_at) || null,
    },
  }
}

export type NewsletterBatch = {
  /** Actionable events, oldest first. */
  events: NewsletterEvent[]
  ignored: number
  invalid: number
}

function occurredAtMs(event: NewsletterEvent): number {
  const parsed = Date.parse(event.occurredAt ?? '')

  // Undated events sort first and, since sort is stable, keep their delivered order.
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Parses a whole delivery.
 *
 * Individual bad events are counted rather than fatal: rejecting a 1000-event batch
 * because one row is malformed would make EmailOctopus redeliver the other 999 for ten
 * days and never get past the same poison event.
 *
 * @returns null when the envelope itself is unusable — the only case worth a 400.
 */
export function parseNewsletterBatch(payload: unknown): NewsletterBatch | null {
  // Deliveries are arrays. A bare object is tolerated so a hand-made test POST works.
  const raw = Array.isArray(payload) ? payload : [payload]

  if (!Array.isArray(payload) && (typeof payload !== 'object' || payload === null)) {
    return null
  }

  const events: NewsletterEvent[] = []
  let ignored = 0
  let invalid = 0

  for (const entry of raw) {
    const parsed = parseNewsletterEvent(entry)

    if (parsed.ok) {
      events.push(parsed.event)
    } else if (parsed.reason === 'ignored') {
      ignored += 1
    } else {
      invalid += 1
    }
  }

  // A batch can hold a subscribe and a later unsubscribe for the same address. Applying
  // them in delivered order is not guaranteed to leave the newer state in place.
  events.sort((a, b) => occurredAtMs(a) - occurredAtMs(b))

  return { events, ignored, invalid }
}

export type ApplyResult = {
  action: 'updated' | 'created' | 'noop'
  contactId: string | null
  /** True when an archived contact shares this address — surfaced for the sync log. */
  archivedMatchExists: boolean
}

/**
 * Applies a subscribe/unsubscribe event to the contact database.
 *
 * Which consents an event moves is asymmetric, and that asymmetry is the whole point of
 * having two:
 *
 * - **Unsubscribing withdraws both.** EmailOctopus unsubscribes are list-level — the
 *   link in the footer of any email removes the contact from the list entirely. The
 *   reader clicked "stop emailing me", not "stop the newsletter", and treating it as
 *   the narrower request would keep sending them course invitations from the same list
 *   they just left. Losing both is also what archives them, which is the intended end.
 * - **Subscribing grants only the newsletter.** The signup form on the website is a
 *   newsletter form. Programme consent is left exactly as it was, because inventing it
 *   from a newsletter signup is claiming consent the contact never gave.
 *
 * Deliberately does **not** restore an archived contact. An external form must not be
 * able to un-archive records the client archived on purpose; instead a fresh lead is
 * created and the collision is reported so a human can merge them. The partial unique
 * index permits one archived and one live row for the same address.
 */
export async function applyNewsletterEvent(
  db: SupabaseClient<Database>,
  event: NewsletterEvent
): Promise<ApplyResult> {
  const subscribed = event.type === 'subscribed'

  const { data: active, error: lookupError } = await db
    .from('contacts')
    .select('id, deleted_at')
    .eq('email', event.email)
    .is('deleted_at', null)
    .maybeSingle()

  if (lookupError) {
    throw new Error(`Newsletter lookup failed: ${lookupError.message}`)
  }

  if (active) {
    // Through the RPC rather than a plain update: it is the only path that can label
    // the resulting ledger entries, and a provider unsubscribe is the single most
    // important thing in that ledger to be able to attribute.
    const { error: consentError } = await db.rpc('apply_contact_consent', {
      p_contact_id: active.id,
      p_newsletter: subscribed,
      // Null leaves programme consent alone on a subscribe; false withdraws it
      // alongside the newsletter on an unsubscribe. See the doc comment.
      p_programs: subscribed ? null : false,
      p_source: 'newsletter_webhook',
      p_evidence: {
        provider_type: event.providerType,
        provider_event_id: event.id,
        occurred_at: event.occurredAt,
      },
    })

    if (consentError) {
      throw new Error(`Newsletter update failed: ${consentError.message}`)
    }

    // Status is intentionally left alone: a newsletter signup must not demote a
    // paying customer back to a lead.
    return { action: 'updated', contactId: active.id, archivedMatchExists: false }
  }

  // Only an archived contact someone could still restore and merge counts. A removed
  // one is gone from the application. Limited rather than `.maybeSingle()`: one address
  // can have several archived rows, and more than one would make that call fail.
  const { data: archived, error: archivedError } = await db
    .from('contacts')
    .select('id')
    .eq('email', event.email)
    .not('deleted_at', 'is', null)
    .is('removed_at', null)
    .limit(1)

  if (archivedError) {
    throw new Error(`Newsletter lookup failed: ${archivedError.message}`)
  }

  const archivedMatchExists = (archived ?? []).length > 0

  // Nothing to unsubscribe. Acknowledge rather than inventing a record.
  if (!subscribed) {
    return { action: 'noop', contactId: null, archivedMatchExists }
  }

  // Created without consent, then granted it through the RPC. One statement would be
  // simpler and would record the grant as `unknown`: a signup is the strongest evidence
  // of consent this system ever holds, and an unattributed entry is the one shape it
  // must not take.
  const { data: created, error: insertError } = await db
    .from('contacts')
    .insert({
      email: event.email,
      first_name: event.firstName || 'Unknown',
      last_name: event.lastName || 'Subscriber',
      subscribed_to_newsletter: false,
      subscribed_to_programs: false,
      status: 'lead',
      is_customer: false,
      source: 'newsletter',
    })
    .select('id')
    .single()

  if (insertError) {
    throw new Error(`Newsletter insert failed: ${insertError.message}`)
  }

  if (created?.id) {
    const { error: consentError } = await db.rpc('apply_contact_consent', {
      p_contact_id: created.id,
      p_newsletter: true,
      p_programs: null,
      p_source: 'newsletter_webhook',
      p_evidence: {
        provider_type: event.providerType,
        provider_event_id: event.id,
        occurred_at: event.occurredAt,
      },
    })

    if (consentError) {
      throw new Error(`Newsletter consent failed: ${consentError.message}`)
    }
  }

  return {
    action: 'created',
    contactId: created?.id ?? null,
    archivedMatchExists,
  }
}

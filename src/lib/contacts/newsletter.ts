import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * Automated newsletter intake (scope 3.2).
 *
 * The previous handler ran a bare `UPDATE ... WHERE email = ?`. For a brand-new website
 * subscriber that matched zero rows, and the endpoint still answered `200 {success:true}`
 * — so every new signup was silently discarded and the requirement was quietly unmet.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type NewsletterEvent = {
  type: 'subscribed' | 'unsubscribed'
  email: string
  firstName: string
  lastName: string
  externalId: string | null
}

export type ParseResult =
  | { ok: true; event: NewsletterEvent }
  | { ok: false; reason: 'invalid' | 'ignored' }

const EVENT_TYPES: Record<string, NewsletterEvent['type']> = {
  'contact.subscribed': 'subscribed',
  'contact.unsubscribed': 'unsubscribed',
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Validates and normalises an inbound EmailOctopus webhook payload. */
export function parseNewsletterEvent(payload: unknown): ParseResult {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'invalid' }
  }

  const body = payload as Record<string, unknown>
  const eventName = readString(body.event)
  const contact = body.contact

  if (typeof contact !== 'object' || contact === null) {
    return { ok: false, reason: 'invalid' }
  }

  const contactRecord = contact as Record<string, unknown>
  const email = readString(contactRecord.email_address).toLowerCase()

  if (!email || !EMAIL_REGEX.test(email)) {
    return { ok: false, reason: 'invalid' }
  }

  if (!eventName) {
    return { ok: false, reason: 'invalid' }
  }

  const type = EVENT_TYPES[eventName]

  // Unknown-but-well-formed events are acknowledged, not rejected — a 4xx would make
  // the provider retry something we will never handle.
  if (!type) {
    return { ok: false, reason: 'ignored' }
  }

  const fields = (contactRecord.fields ?? {}) as Record<string, unknown>

  return {
    ok: true,
    event: {
      type,
      email,
      firstName: readString(fields.FirstName),
      lastName: readString(fields.LastName),
      externalId: readString(contactRecord.id) || null,
    },
  }
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
    const { error: updateError } = await db
      .from('contacts')
      .update({ subscribed_to_newsletter: subscribed })
      .eq('id', active.id)

    if (updateError) {
      throw new Error(`Newsletter update failed: ${updateError.message}`)
    }

    // Status is intentionally left alone: a newsletter signup must not demote a
    // paying customer back to a lead.
    return { action: 'updated', contactId: active.id, archivedMatchExists: false }
  }

  const { data: archived, error: archivedError } = await db
    .from('contacts')
    .select('id')
    .eq('email', event.email)
    .not('deleted_at', 'is', null)
    .maybeSingle()

  if (archivedError) {
    throw new Error(`Newsletter lookup failed: ${archivedError.message}`)
  }

  const archivedMatchExists = Boolean(archived)

  // Nothing to unsubscribe. Acknowledge rather than inventing a record.
  if (!subscribed) {
    return { action: 'noop', contactId: null, archivedMatchExists }
  }

  const { data: created, error: insertError } = await db
    .from('contacts')
    .insert({
      email: event.email,
      first_name: event.firstName || 'Unknown',
      last_name: event.lastName || 'Subscriber',
      subscribed_to_newsletter: true,
      status: 'lead',
      is_customer: false,
      source: 'newsletter',
    })
    .select('id')
    .single()

  if (insertError) {
    throw new Error(`Newsletter insert failed: ${insertError.message}`)
  }

  return {
    action: 'created',
    contactId: created?.id ?? null,
    archivedMatchExists,
  }
}

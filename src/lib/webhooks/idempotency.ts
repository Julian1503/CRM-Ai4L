import { createHash } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * At-least-once delivery protection.
 *
 * Webhook providers retry on any non-2xx and on timeouts, so the same event arrives
 * more than once. Without a ledger, a retried `unsubscribed` can land *after* a newer
 * `subscribed` and silently undo it.
 *
 * The uniqueness constraint on (provider, event_id) is the whole mechanism: an insert
 * that conflicts means the event was already handled.
 */

/**
 * Stable identifier for a delivery.
 *
 * Prefers a provider-supplied id. Falls back to a hash of the exact bytes received,
 * which is a sound key because a genuine retry replays an identical body.
 */
export function deriveEventId(rawBody: string, providedId?: string | null): string {
  const trimmed = typeof providedId === 'string' ? providedId.trim() : ''

  if (trimmed !== '') {
    return trimmed
  }

  return `sha256:${createHash('sha256').update(rawBody, 'utf8').digest('hex')}`
}

/**
 * Claims an event id.
 *
 * @returns true when this delivery is new and should be processed, false when it has
 * already been handled.
 */
export async function claimWebhookEvent(
  db: SupabaseClient<Database>,
  provider: string,
  eventId: string,
  eventType: string | null
): Promise<boolean> {
  const { error } = await db
    .from('webhook_events')
    .insert({ provider, event_id: eventId, event_type: eventType })

  if (!error) {
    return true
  }

  // 23505 = unique_violation: another delivery of this event already claimed it.
  if (error.code === '23505') {
    return false
  }

  throw new Error(`Could not record webhook event: ${error.message}`)
}

import { createHash } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * At-least-once delivery protection with recoverable outcomes (audit H11).
 *
 * Providers retry on any non-2xx and on timeouts, so the same event arrives more than
 * once. The ledger used to record only that an event had been *claimed*: a process that
 * died before releasing its claim left the event "handled" forever, and every retry was
 * dismissed as a duplicate. Now an event has an outcome and a lease:
 *
 *   claimed      process it, then complete it with the token
 *   completed    a finished (or terminally refused) event: acknowledge the duplicate
 *   in_progress  another delivery holds a live lease: answer retryable (503)
 *
 * A redelivery of an event whose worker died, or that failed retryably, takes it over.
 * Handlers that change business data complete the event inside the same database call
 * (apply_checkout_payment, apply_calendly_event), so the two cannot disagree.
 */

/**
 * Stable identifier for an event.
 *
 * Prefers a provider-supplied id. Falls back to a hash of the payload it was derived
 * from, which is a sound key because a genuine retry replays identical content.
 *
 * A delivery is not the unit: EmailOctopus batches up to 1000 events into one request,
 * so keying on the request would let 999 events ride in on the first one's claim.
 */
export function deriveEventId(payload: string, providedId?: string | null): string {
  const trimmed = typeof providedId === 'string' ? providedId.trim() : ''

  if (trimmed !== '') {
    return trimmed
  }

  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}

export type WebhookClaim =
  | { outcome: 'claimed'; token: string }
  | { outcome: 'completed' }
  | { outcome: 'in_progress' }

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{
  data: unknown
  error: { message: string } | null
}>

function rpc(db: SupabaseClient<Database>): Rpc {
  return db.rpc.bind(db) as unknown as Rpc
}

export async function claimWebhookEvent(
  db: SupabaseClient<Database>,
  provider: string,
  eventId: string,
  eventType: string | null
): Promise<WebhookClaim> {
  const { data, error } = await rpc(db)('claim_webhook_event', {
    p_provider: provider,
    p_event_id: eventId,
    p_event_type: eventType,
  })

  if (error) throw new Error(`Could not record webhook event: ${error.message}`)

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; claim_token?: string } | null
  if (row?.outcome === 'claimed' && row.claim_token) return { outcome: 'claimed', token: row.claim_token }
  if (row?.outcome === 'in_progress') return { outcome: 'in_progress' }
  if (row?.outcome === 'completed') return { outcome: 'completed' }

  throw new Error('Could not record webhook event: unexpected claim result.')
}

/**
 * Records a claimed event's outcome. A failure to record is logged, not thrown: the
 * caller is already answering, and an unrecorded completion simply expires into a
 * retryable claim, which is safe because every handler is idempotent.
 */
export async function completeWebhookEvent(
  db: SupabaseClient<Database>,
  claim: { provider: string; eventId: string; token: string },
  status: 'completed' | 'failed_retryable' | 'failed_terminal',
  errorMessage: string | null = null
): Promise<void> {
  const { error } = await rpc(db)('complete_webhook_event', {
    p_provider: claim.provider,
    p_event_id: claim.eventId,
    p_token: claim.token,
    p_status: status,
    p_error: errorMessage,
  })

  if (error) {
    console.error(`Could not record the outcome of webhook event ${claim.provider}/${claim.eventId}: ${error.message}`)
  }
}

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

import { sendBookingPaidEmail } from './paidEmail'

/**
 * Drains notification_outbox (audit H10).
 *
 * A confirmation email is queued in the same transaction that marks the booking paid,
 * keyed by the booking, so there is exactly one logical message however many times the
 * payment is reported. Delivery is retried here with backoff, independently of the
 * payment, and Resend's idempotency key (`booking-paid-<id>`) stops a retry that raced
 * a slow success from sending twice.
 *
 * The scheduling link needs the raw booking token, which is never stored; it is read
 * from Stripe's copy of the checkout's success URL at send time.
 */

export type RetrieveCheckout = (sessionId: string) => Promise<{ id: string; success_url?: string | null }>

export type NotificationResult = { claimed: number; sent: number; skipped: number; retried: number }

type ClaimedNotification = {
  id: string
  claim_token: string
  kind: string
  booking_id: string | null
  stripe_session_id: string | null
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{
  data: unknown
  error: { message: string } | null
}>

export async function processNotifications(
  db: SupabaseClient<Database>,
  options: { retrieveCheckout: RetrieveCheckout | null; limit?: number }
): Promise<NotificationResult> {
  const rpc = db.rpc.bind(db) as unknown as Rpc
  const { data, error } = await rpc('claim_notifications', { p_limit: options.limit ?? 20 })
  if (error) throw new Error(`Could not claim notifications: ${error.message}`)

  const claimed = (data ?? []) as ClaimedNotification[]
  const result: NotificationResult = { claimed: claimed.length, sent: 0, skipped: 0, retried: 0 }

  for (const note of claimed) {
    let status: 'sent' | 'skipped' | 'retry' = 'retry'
    let reason: string | null = null

    try {
      if (note.kind !== 'booking_paid_confirmation' || !note.booking_id || !note.stripe_session_id) {
        status = 'skipped'
        reason = 'unsupported or incomplete notification'
      } else if (!options.retrieveCheckout) {
        reason = 'Stripe is not configured'
      } else {
        const session = await options.retrieveCheckout(note.stripe_session_id)
        const sent = await sendBookingPaidEmail(db, session, note.booking_id)
        if (sent.status === 'sent') {
          status = 'sent'
        } else if (sent.reason === 'not_configured') {
          // Email switched off: keep it queued so enabling Resend later still sends it.
          reason = 'email is not configured'
        } else {
          status = 'skipped'
          reason = sent.reason
        }
      }
    } catch (caught) {
      reason = caught instanceof Error ? caught.message : 'send failed'
    }

    const { error: completeError } = await rpc('complete_notification', {
      p_id: note.id,
      p_token: note.claim_token,
      p_status: status,
      p_error: reason,
    })
    if (completeError) console.error('Could not settle a notification:', completeError.message)

    if (status === 'sent') result.sent += 1
    else if (status === 'skipped') result.skipped += 1
    else result.retried += 1
  }

  return result
}

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * The one way a completed Stripe checkout marks a booking paid (audit H10).
 *
 * Used by both the return page (browser-first) and the webhook; either may arrive
 * first, and either may arrive twice. The database function verifies the checkout
 * belongs to the booking and is the expected $0 AUD, never moves a booking backwards,
 * treats a repeat of the same checkout as success, refuses a different checkout, and
 * queues exactly one confirmation email.
 */

export type PaymentOutcome = 'applied' | 'already_applied' | 'not_ready' | 'not_found' | 'mismatch'

export type CheckoutSessionFacts = {
  id: string
  status: string | null
  payment_status: string | null
  amount_total: number | null
  currency: string | null
  metadata?: Record<string, string> | null
}

/** True when Stripe says the checkout is finished and nothing is owed. */
export function isCompletedCheckout(session: CheckoutSessionFacts): boolean {
  return (
    session.status === 'complete' &&
    (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')
  )
}

export async function applyCheckoutPayment(
  db: SupabaseClient<Database>,
  params: {
    bookingId: string
    session: CheckoutSessionFacts
    /** The webhook claim to complete in the same transaction. */
    webhook?: { provider: string; eventId: string; token: string }
  }
): Promise<PaymentOutcome> {
  const rpc = db.rpc.bind(db) as unknown as (
    fn: 'apply_checkout_payment',
    args: Record<string, unknown>
  ) => PromiseLike<{ data: PaymentOutcome | null; error: { message: string } | null }>

  const { data, error } = await rpc('apply_checkout_payment', {
    p_booking_id: params.bookingId,
    p_session_id: params.session.id,
    p_amount: params.session.amount_total,
    p_currency: params.session.currency,
    p_provider: params.webhook?.provider ?? null,
    p_event_id: params.webhook?.eventId ?? null,
    p_event_token: params.webhook?.token ?? null,
  })

  if (error) throw new Error(`Could not record payment: ${error.message}`)
  if (!data) throw new Error('Could not record payment: no outcome returned.')

  return data
}

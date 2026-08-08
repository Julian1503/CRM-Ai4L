/**
 * Consultation checkout.
 *
 * The consultation lists at $500 and is discounted to $0 by a 100%-off coupon, so the
 * client sees the value they are receiving and pays nothing — which is the arrangement
 * the scope describes.
 *
 * Note on coupons vs per-lead promotion codes: the original plan minted a promotion code
 * per lead with `max_redemptions: 1`. That is redundant here — single use is already
 * enforced by the booking token (`consumed_at`), which is checked before a session is
 * ever created. A single reusable coupon achieves the same outcome without an extra API
 * call and an extra object to reconcile per recipient.
 */

/** Minimal Stripe surface used, so this is testable without the SDK. */
export type CheckoutCreator = {
  checkout: {
    sessions: {
      create: (params: Record<string, unknown>) => Promise<{ id: string; url: string | null }>
    }
  }
}

export type CheckoutParams = {
  priceId: string
  couponId: string
  bookingId: string
  email: string
  successUrl: string
  cancelUrl: string
}

export async function createConsultationCheckout(
  stripe: CheckoutCreator,
  params: CheckoutParams
): Promise<{ sessionId: string; url: string | null }> {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: params.priceId, quantity: 1 }],
    discounts: [{ coupon: params.couponId }],

    // With a 100% discount the total is zero, and Stripe should not demand a card for
    // a zero-value checkout.
    payment_method_collection: 'if_required',

    customer_email: params.email,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,

    // The webhook arrives with no context beyond the session, so the booking id travels
    // in session metadata. Deliberately *not* also set via `payment_intent_data`: at a
    // $0 total Stripe creates no PaymentIntent, and passing that field may be rejected.
    // Session metadata is always present, and the webhook also matches on session id.
    metadata: { booking_id: params.bookingId },
  })

  return { sessionId: session.id, url: session.url }
}

import 'server-only'

import Stripe from 'stripe'

/**
 * Stripe configuration.
 *
 * Read at call time so a missing key surfaces as a handled error on the routes that
 * need it, rather than breaking the build for everyone else.
 */

/** The consultation's list value. Displayed, then discounted to zero. */
export const CONSULTATION_LIST_AMOUNT_CENTS = 50_000
export const CONSULTATION_CURRENCY = 'aud'

export type StripeConfig = {
  secretKey: string
  priceId: string
  couponId: string
  webhookSecret: string
}

export function getStripeConfig(): StripeConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim()
  const priceId = process.env.STRIPE_CONSULTATION_PRICE_ID?.trim()
  const couponId = process.env.STRIPE_CONSULTATION_COUPON_ID?.trim()
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim()

  if (!secretKey || !priceId || !couponId || !webhookSecret) {
    return null
  }

  return { secretKey, priceId, couponId, webhookSecret }
}

export function getStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    // Pinned so a Stripe-side API upgrade cannot silently change payload shapes.
    // Must match the version this SDK build expects; typecheck enforces that.
    apiVersion: '2026-07-29.dahlia',
    typescript: true,
  })
}

import type { NextResponse } from 'next/server'

import { ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { getStripeClient, getStripeConfig } from '@/lib/stripe/client'
import { checkStripeReadiness } from '@/lib/stripe/health'

export const runtime = 'nodejs'

/**
 * Whether booking links can actually reach Stripe Checkout.
 *
 * Runs inside the deployment, so it reads the environment the booking route reads —
 * which is the whole point: a local preflight validates the machine it runs on, and the
 * configuration that matters is the one Vercel holds.
 *
 * Authenticated: it names configuration, which no visitor should see.
 */
export async function GET(): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const config = getStripeConfig()

  if (!config) {
    return ok({
      ok: false,
      configured: false,
      mode: 'unknown',
      price: null,
      coupon: null,
      problems: [
        'Stripe is not configured in this environment. Booking links will answer ' +
          '"temporarily unavailable" until STRIPE_SECRET_KEY, ' +
          'STRIPE_CONSULTATION_PRICE_ID, STRIPE_CONSULTATION_COUPON_ID and ' +
          'STRIPE_WEBHOOK_SECRET are all set.',
      ],
    })
  }

  try {
    const stripe = getStripeClient(config.secretKey)
    const readiness = await checkStripeReadiness(stripe, config)

    return ok({ ...readiness, configured: true })
  } catch (error) {
    return serverError(error, 'Could not check Stripe.')
  }
}

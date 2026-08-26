import 'server-only'

/**
 * Stripe readiness, checked from inside the deployment.
 *
 * `scripts/preflight.mjs` already validates the price and the coupon — but against
 * whatever `.env.local` holds on the machine running it, which is not what a deployed
 * function reads. That gap is exactly how a booking link reached a lead with a working
 * page and a button that could only ever fail: the checkout call was rejected by Stripe,
 * the public route answered with its deliberately vague message, and nothing in the CRM
 * said otherwise.
 *
 * So this runs with the *deployed* environment, and the Operations screen shows it.
 */

export type StripeMode = 'test' | 'live' | 'unknown'

/** The mode a secret key belongs to, from its prefix. Stripe guarantees these. */
export function stripeKeyMode(secretKey: string): StripeMode {
  const key = secretKey.trim()

  if (key.startsWith('sk_live') || key.startsWith('rk_live')) return 'live'
  if (key.startsWith('sk_test') || key.startsWith('rk_test')) return 'test'

  return 'unknown'
}

export type StripeErrorDetail = {
  type: string
  code: string | null
  param: string | null
  message: string
  requestId: string | null
}

/**
 * Pulls the parts of a Stripe error worth logging.
 *
 * Deliberately not the whole error object: it carries the request payload, and the
 * payload carries a customer's email address. `type`, `code` and `param` are what name
 * the misconfiguration — `invalid_request_error` / `resource_missing` / `line_items[0]
 * [price]` says "that price does not exist in this account" and nothing else.
 */
export function describeStripeError(error: unknown): StripeErrorDetail {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}

  const read = (key: string): string | null =>
    typeof record[key] === 'string' && record[key] !== '' ? (record[key] as string) : null

  return {
    type: read('type') ?? (error instanceof Error ? error.name : 'unknown_error'),
    code: read('code'),
    param: read('param'),
    message: read('message') ?? (error instanceof Error ? error.message : String(error)),
    requestId: read('requestId') ?? read('request_id'),
  }
}

/** The consultation's list price, in cents. Mirrors `CONSULTATION_LIST_AMOUNT_CENTS`. */
const EXPECTED_AMOUNT_CENTS = 50_000
const EXPECTED_CURRENCY = 'aud'

type PriceLike = {
  id: string
  active: boolean
  livemode: boolean
  currency: string
  unit_amount: number | null
  type: string
}

type CouponLike = {
  id: string
  valid: boolean
  livemode: boolean
  percent_off: number | null
  duration: string
}

/** The read-only slice of Stripe used here, so this is testable without the SDK. */
export type StripeResourceReader = {
  prices: { retrieve: (id: string) => Promise<PriceLike> }
  coupons: { retrieve: (id: string) => Promise<CouponLike> }
}

export type StripeReadiness = {
  ok: boolean
  mode: StripeMode
  price: { id: string; amount: number | null; currency: string; active: boolean } | null
  coupon: { id: string; percentOff: number | null; valid: boolean } | null
  /** Every problem found, worded as something an operator can act on. */
  problems: string[]
}

/**
 * Checks that the configured price and coupon exist and can produce a $0 checkout.
 *
 * Every failure is collected rather than thrown: a mode mismatch usually breaks both
 * resources at once, and reporting only the first would send someone round the loop
 * twice.
 */
export async function checkStripeReadiness(
  stripe: StripeResourceReader,
  config: { secretKey: string; priceId: string; couponId: string }
): Promise<StripeReadiness> {
  const mode = stripeKeyMode(config.secretKey)
  const problems: string[] = []

  if (mode === 'unknown') {
    problems.push('STRIPE_SECRET_KEY does not look like a Stripe secret key.')
  }

  let price: StripeReadiness['price'] = null
  let coupon: StripeReadiness['coupon'] = null

  try {
    const found = await stripe.prices.retrieve(config.priceId)

    price = {
      id: found.id,
      amount: found.unit_amount,
      currency: found.currency,
      active: found.active,
    }

    // The failure mode that started this: an id created in one mode used with a key
    // from the other. Stripe reports it as "No such price", which reads like a typo.
    if (mode !== 'unknown' && found.livemode !== (mode === 'live')) {
      problems.push(
        `The consultation price belongs to ${found.livemode ? 'live' : 'test'} mode but ` +
          `STRIPE_SECRET_KEY is a ${mode} key. Booking cannot start until both match.`
      )
    }

    if (!found.active) {
      problems.push(`The consultation price ${found.id} is archived in Stripe.`)
    }

    if (found.type !== 'one_time') {
      problems.push(
        `The consultation price ${found.id} is recurring; checkout is created in ` +
          '`payment` mode and Stripe rejects a recurring price there.'
      )
    }

    if (found.unit_amount !== EXPECTED_AMOUNT_CENTS || found.currency !== EXPECTED_CURRENCY) {
      problems.push(
        `The consultation price is ${found.unit_amount ?? 'null'} ` +
          `${found.currency.toUpperCase()}; the booking page advertises $500 AUD.`
      )
    }
  } catch (error) {
    problems.push(
      `STRIPE_CONSULTATION_PRICE_ID (${config.priceId}) could not be read: ` +
        `${describeStripeError(error).message}`
    )
  }

  try {
    const found = await stripe.coupons.retrieve(config.couponId)

    coupon = { id: found.id, percentOff: found.percent_off, valid: found.valid }

    if (mode !== 'unknown' && found.livemode !== (mode === 'live')) {
      problems.push(
        `The consultation coupon belongs to ${found.livemode ? 'live' : 'test'} mode but ` +
          `STRIPE_SECRET_KEY is a ${mode} key.`
      )
    }

    if (!found.valid) {
      problems.push(`The consultation coupon ${found.id} is no longer valid.`)
    }

    // Not cosmetic: the consultation is advertised as free, so anything short of 100%
    // off would charge a lead who was promised no cost.
    if (found.percent_off !== 100) {
      problems.push(
        `The consultation coupon takes ${found.percent_off ?? 0}% off; the booking page ` +
          'promises the consultation at no cost.'
      )
    }
  } catch (error) {
    problems.push(
      `STRIPE_CONSULTATION_COUPON_ID (${config.couponId}) could not be read: ` +
        `${describeStripeError(error).message}`
    )
  }

  return { ok: problems.length === 0, mode, price, coupon, problems }
}

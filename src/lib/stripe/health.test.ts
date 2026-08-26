/**
 * @jest-environment node
 */
import { checkStripeReadiness, describeStripeError, stripeKeyMode } from './health'

const price = {
  id: 'price_1',
  active: true,
  livemode: false,
  currency: 'aud',
  unit_amount: 50_000,
  type: 'one_time',
}

const coupon = {
  id: 'coupon_1',
  valid: true,
  livemode: false,
  percent_off: 100,
  duration: 'once',
}

function reader(overrides: { price?: unknown; coupon?: unknown } = {}) {
  return {
    prices: {
      retrieve: jest.fn().mockImplementation(async () => {
        const value = overrides.price ?? price
        if (value instanceof Error) throw value
        return value
      }),
    },
    coupons: {
      retrieve: jest.fn().mockImplementation(async () => {
        const value = overrides.coupon ?? coupon
        if (value instanceof Error) throw value
        return value
      }),
    },
  } as never
}

const config = { secretKey: 'sk_test_abc', priceId: 'price_1', couponId: 'coupon_1' }

describe('stripeKeyMode', () => {
  it.each([
    ['sk_test_abc', 'test'],
    ['sk_live_abc', 'live'],
    ['rk_live_abc', 'live'],
    ['pk_test_abc', 'unknown'],
    ['', 'unknown'],
  ])('reads %s as %s', (key, expected) => {
    expect(stripeKeyMode(key)).toBe(expected)
  })
})

describe('describeStripeError', () => {
  it('keeps the fields that name a misconfiguration', () => {
    const error = Object.assign(new Error('No such price: price_1'), {
      type: 'StripeInvalidRequestError',
      code: 'resource_missing',
      param: 'line_items[0][price]',
      requestId: 'req_1',
    })

    expect(describeStripeError(error)).toEqual({
      type: 'StripeInvalidRequestError',
      code: 'resource_missing',
      param: 'line_items[0][price]',
      message: 'No such price: price_1',
      requestId: 'req_1',
    })
  })

  it('handles something that is not a Stripe error at all', () => {
    expect(describeStripeError(new TypeError('fetch failed'))).toMatchObject({
      type: 'TypeError',
      code: null,
      message: 'fetch failed',
    })
  })
})

describe('checkStripeReadiness', () => {
  it('passes a correctly configured account', async () => {
    const readiness = await checkStripeReadiness(reader(), config)

    expect(readiness).toMatchObject({ ok: true, mode: 'test', problems: [] })
    expect(readiness.price).toEqual({
      id: 'price_1',
      amount: 50_000,
      currency: 'aud',
      active: true,
    })
  })

  it('names a mode mismatch instead of leaving "No such price"', async () => {
    // The failure that took a booking link down in production: test-mode ids against a
    // live key. Stripe words it as a missing resource, which reads like a typo.
    const readiness = await checkStripeReadiness(reader(), {
      ...config,
      secretKey: 'sk_live_abc',
    })

    expect(readiness.ok).toBe(false)
    expect(readiness.problems.join(' ')).toMatch(/price belongs to test mode but .* live key/)
  })

  it('reports a price that does not exist in the account', async () => {
    const missing = Object.assign(new Error('No such price: price_1'), {
      type: 'StripeInvalidRequestError',
      code: 'resource_missing',
    })

    const readiness = await checkStripeReadiness(reader({ price: missing }), config)

    expect(readiness.ok).toBe(false)
    expect(readiness.price).toBeNull()
    expect(readiness.problems[0]).toContain('No such price')
  })

  it('collects every problem rather than stopping at the first', async () => {
    // A mode mismatch usually breaks both resources; reporting one sends the operator
    // round the loop twice.
    const readiness = await checkStripeReadiness(
      reader({
        price: { ...price, active: false, type: 'recurring' },
        coupon: { ...coupon, percent_off: 50 },
      }),
      config
    )

    expect(readiness.problems).toHaveLength(3)
    expect(readiness.problems.join(' ')).toMatch(/archived/)
    expect(readiness.problems.join(' ')).toMatch(/recurring/)
    expect(readiness.problems.join(' ')).toMatch(/50% off/)
  })

  it('refuses a coupon that would charge a lead who was promised no cost', async () => {
    const readiness = await checkStripeReadiness(
      reader({ coupon: { ...coupon, percent_off: null } }),
      config
    )

    expect(readiness.ok).toBe(false)
    expect(readiness.problems.join(' ')).toMatch(/no cost/)
  })
})

/**
 * @jest-environment node
 */
const mockLoad = jest.fn()
const mockList = jest.fn()
const mockPrice = jest.fn()
const mockCoupon = jest.fn()
const mockAccount = jest.fn()

jest.mock('@/lib/marketing/providers/credentials', () => ({ loadEmailOctopusCredentials: () => mockLoad() }))
jest.mock('@/lib/marketing/providers/emailOctopus', () => ({ listMergeTags: (...args: unknown[]) => mockList(...args) }))
const mockReadRuns = jest.fn()
jest.mock('./cronRuns', () => ({ readLastCronRuns: (...args: unknown[]) => mockReadRuns(...args) }))
jest.mock('@/lib/stripe/client', () => ({
  getStripeClient: () => ({
    prices: { retrieve: (...args: unknown[]) => mockPrice(...args) },
    coupons: { retrieve: (...args: unknown[]) => mockCoupon(...args) },
    accounts: { retrieveCurrent: (...args: unknown[]) => mockAccount(...args) },
  }),
}))

import { healthDeps } from './server'

describe('healthDeps', () => {
  it('wires the real loaders and a read-only, time-limited Stripe reader', async () => {
    const deps = healthDeps({ db: true } as never)
    mockLoad.mockResolvedValue({ apiKey: 'k', listId: 'l' })
    mockList.mockResolvedValue({ ok: true, tags: [] })

    await deps.loadEmailOctopusCredentials()
    await deps.listMergeTags({ apiKey: 'k', listId: 'l' })
    const stripe = deps.stripe('sk_test_x')
    await stripe.prices.retrieve('price_1')
    await stripe.coupons.retrieve('coupon_1')
    await stripe.accounts.retrieveCurrent()

    expect(mockLoad).toHaveBeenCalled()
    expect(mockList).toHaveBeenCalledWith({ apiKey: 'k', listId: 'l', fetchImpl: undefined })
    const options = { timeout: 5000, maxNetworkRetries: 0 }
    expect(mockPrice).toHaveBeenCalledWith('price_1', {}, options)
    expect(mockCoupon).toHaveBeenCalledWith('coupon_1', {}, options)
    expect(mockAccount).toHaveBeenCalledWith({}, options)
    await deps.readLastCronRuns('jobs')
    expect(mockReadRuns).toHaveBeenCalledWith({ db: true }, 'jobs')
    expect(deps.db).toEqual({ db: true })
    expect(deps.now()).toBeInstanceOf(Date)
  })
})

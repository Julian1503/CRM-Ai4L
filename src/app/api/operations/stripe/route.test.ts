/**
 * @jest-environment node
 */
const mockGetSession = jest.fn()
const mockGetStripeConfig = jest.fn()
const mockCheckReadiness = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/stripe/client', () => ({
  getStripeConfig: () => mockGetStripeConfig(),
  getStripeClient: () => ({ prices: {}, coupons: {} }),
}))
jest.mock('@/lib/stripe/health', () => ({
  checkStripeReadiness: (...args: unknown[]) => mockCheckReadiness(...args),
}))

import { GET } from './route'

const CONFIG = {
  secretKey: 'sk_test_1',
  priceId: 'price_1',
  couponId: 'coupon_1',
  webhookSecret: 'whsec_1',
}

describe('GET /api/operations/stripe', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    mockGetStripeConfig.mockReturnValue(CONFIG)
    mockCheckReadiness.mockResolvedValue({
      ok: true,
      mode: 'test',
      price: { id: 'price_1', amount: 50_000, currency: 'aud', active: true },
      coupon: { id: 'coupon_1', percentOff: 100, valid: true },
      problems: [],
    })
  })

  it('refuses an unauthenticated request', async () => {
    // It names configuration, which is for operators only.
    mockGetSession.mockResolvedValue(null)

    expect((await GET()).status).toBe(401)
    expect(mockCheckReadiness).not.toHaveBeenCalled()
  })

  it('reports a ready configuration', async () => {
    await expect((await GET()).json()).resolves.toMatchObject({
      ok: true,
      configured: true,
      mode: 'test',
    })
  })

  it('says booking is unconfigured rather than calling Stripe with nothing', async () => {
    mockGetStripeConfig.mockReturnValue(null)

    const body = await (await GET()).json()

    expect(body).toMatchObject({ ok: false, configured: false })
    expect(body.problems[0]).toMatch(/not configured/i)
    expect(mockCheckReadiness).not.toHaveBeenCalled()
  })

  it('passes the problems through so the screen can name them', async () => {
    mockCheckReadiness.mockResolvedValue({
      ok: false,
      mode: 'live',
      price: null,
      coupon: null,
      problems: ['The consultation price belongs to test mode but the key is live.'],
    })

    await expect((await GET()).json()).resolves.toMatchObject({
      ok: false,
      problems: ['The consultation price belongs to test mode but the key is live.'],
    })
  })

  it('answers 500 rather than throwing when Stripe is unreachable', async () => {
    mockCheckReadiness.mockRejectedValue(new Error('connection reset'))

    expect((await GET()).status).toBe(500)
  })
})

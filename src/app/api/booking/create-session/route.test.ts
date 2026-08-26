/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'
import { hashBookingToken } from '@/lib/booking/token'

const mockGetAdminClient = jest.fn()
const mockGetStripeConfig = jest.fn()
const mockSessionCreate = jest.fn()
const mockSessionRetrieve = jest.fn()

jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockGetAdminClient() }))
jest.mock('@/lib/stripe/client', () => ({
  getStripeConfig: () => mockGetStripeConfig(),
  getStripeClient: () => ({
    checkout: { sessions: { create: mockSessionCreate, retrieve: mockSessionRetrieve } },
  }),
}))

import { POST } from './route'

const URL_PATH = 'https://crm.example.com/api/booking/create-session'
const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const PAST = new Date(Date.now() - 86_400_000).toISOString()

function request(body: unknown = { token: 'tok-1' }) {
  return new NextRequest(URL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function setupDb(booking: unknown) {
  const bookings = createQueryBuilderMock([
    { data: booking, error: null },
    { data: null, error: null },
  ])
  mockGetAdminClient.mockReturnValue(createDbMock(bookings))
  return { bookings }
}

const validBooking = {
  id: 'b1',
  expires_at: FUTURE,
  consumed_at: null,
  status: 'pending',
  contact: { id: 'c1', email: 'lead@example.com', first_name: 'Ada', last_name: 'L' },
}

describe('POST /api/booking/create-session', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetStripeConfig.mockReturnValue({
      secretKey: 'sk_test',
      priceId: 'price_1',
      couponId: 'coupon_1',
      webhookSecret: 'whsec_1',
    })
    mockSessionCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/x' })
    mockSessionRetrieve.mockResolvedValue({
      id: 'cs_1',
      status: 'open',
      url: 'https://checkout.stripe.com/x',
    })
    setupDb(validBooking)
  })

  it('starts a checkout for a valid token', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      url: 'https://checkout.stripe.com/x',
    })
  })

  it('looks the booking up by hash, never by raw token', async () => {
    const { bookings } = setupDb(validBooking)

    await POST(request({ token: 'tok-1' }))

    expect(bookings.allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['token_hash', hashBookingToken('tok-1')],
    })
  })

  it('consumes the link so a forwarded copy cannot open a second checkout', async () => {
    const { bookings } = setupDb(validBooking)

    await POST(request())

    const update = bookings.argsFor('update') as [Record<string, unknown>]
    expect(update[0]).toMatchObject({ consumed_at: expect.any(String), stripe_session_id: 'cs_1' })
  })

  it('rejects a missing token', async () => {
    expect((await POST(request({}))).status).toBe(400)
  })

  it('rejects a malformed body', async () => {
    expect((await POST(request('not json'))).status).toBe(400)
  })

  it('rejects an unknown token', async () => {
    setupDb(null)

    expect((await POST(request())).status).toBe(404)
  })

  it('rejects an expired booking', async () => {
    setupDb({ ...validBooking, expires_at: PAST })

    expect((await POST(request())).status).toBe(410)
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('resumes the existing checkout after returning through the cancel URL', async () => {
    setupDb({
      ...validBooking,
      consumed_at: new Date().toISOString(),
      status: 'checkout_started',
      stripe_session_id: 'cs_1',
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ resumed: true })
    expect(mockSessionRetrieve).toHaveBeenCalledWith('cs_1')
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('continues to scheduling when the existing session already completed', async () => {
    setupDb({
      ...validBooking,
      consumed_at: new Date().toISOString(),
      status: 'checkout_started',
      stripe_session_id: 'cs_1',
    })
    mockSessionRetrieve.mockResolvedValue({ id: 'cs_1', status: 'complete', url: null })

    const body = await (await POST(request())).json()

    expect(body.url).toBe('https://crm.example.com/book/tok-1/scheduled?session=cs_1')
  })

  it('rejects a cancelled booking', async () => {
    setupDb({ ...validBooking, status: 'cancelled' })

    expect((await POST(request())).status).toBe(410)
  })

  it('gives the same message whatever the reason, so tokens cannot be probed', async () => {
    setupDb(null)
    const notFound = await (await POST(request())).json()

    setupDb({ ...validBooking, expires_at: PAST })
    const expired = await (await POST(request())).json()

    expect(notFound.error).toBe(expired.error)
  })

  it('reports unavailable rather than erroring when Stripe is unconfigured', async () => {
    mockGetStripeConfig.mockReturnValue(null)

    expect((await POST(request())).status).toBe(503)
  })

  it('does not leak internals when Stripe fails', async () => {
    mockSessionCreate.mockRejectedValue(new Error('No such coupon: coupon_1'))

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).not.toMatch(/coupon/i)
  })

  describe('when a failure has to be traced', () => {
    let logged: unknown[][]

    beforeEach(() => {
      logged = []
      jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        logged.push(args)
      })
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('hands the visitor a reference that appears in the log', async () => {
      // Without it, "Could not start booking" was the entire evidence trail: the
      // visitor could not report anything the logs could be searched for.
      mockSessionCreate.mockRejectedValue(
        Object.assign(new Error('No such price: price_1'), {
          type: 'StripeInvalidRequestError',
          code: 'resource_missing',
          param: 'line_items[0][price]',
        })
      )

      const body = await (await POST(request())).json()

      expect(body.reference).toMatch(/^[0-9a-f]{8}$/)
      expect(logged[0][1]).toMatchObject({
        reference: body.reference,
        bookingId: 'b1',
        code: 'resource_missing',
        param: 'line_items[0][price]',
        message: 'No such price: price_1',
      })
    })

    it('never writes the booking token to the log', async () => {
      // The token is the credential for this booking; a log line is not a place for it.
      mockSessionCreate.mockRejectedValue(new Error('nope'))

      await POST(request({ token: 'super-secret-token' }))

      expect(JSON.stringify(logged)).not.toContain('super-secret-token')
    })
  })
})

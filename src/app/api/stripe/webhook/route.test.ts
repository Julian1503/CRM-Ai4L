/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetAdminClient = jest.fn()
const mockConstructEvent = jest.fn()
const mockGetStripeConfig = jest.fn()
const mockStartIntegrationDelivery = jest.fn().mockResolvedValue('delivery-1')
const mockCompleteIntegrationDelivery = jest.fn().mockResolvedValue(undefined)

jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockGetAdminClient() }))
jest.mock('@/lib/stripe/client', () => ({
  getStripeConfig: () => mockGetStripeConfig(),
  getStripeClient: () => ({ webhooks: { constructEvent: mockConstructEvent } }),
}))
jest.mock('@/lib/operations/deliveries', () => ({
  startIntegrationDelivery: (...args: unknown[]) => mockStartIntegrationDelivery(...args),
  completeIntegrationDelivery: (...args: unknown[]) => mockCompleteIntegrationDelivery(...args),
}))

import { POST } from './route'

const URL_PATH = 'https://crm.example.com/api/stripe/webhook'

function request(body = '{"id":"evt_1"}', signature: string | null = 't=1,v1=abc') {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature !== null) headers['stripe-signature'] = signature

  return new NextRequest(URL_PATH, { method: 'POST', headers, body })
}

const completedEvent = {
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_1',
      status: 'complete',
      payment_status: 'no_payment_required',
      amount_total: 0,
      metadata: { booking_id: 'b1' },
    },
  },
}

function setupDb(claimed = true) {
  const webhookEvents = createQueryBuilderMock(
    claimed ? { data: null, error: null } : { data: null, error: { code: '23505', message: 'dup' } }
  )
  const bookings = createQueryBuilderMock({ data: [{ id: 'b1' }], error: null })

  const db = createDbMock((table: string) =>
    table === 'webhook_events' ? webhookEvents : bookings
  )
  mockGetAdminClient.mockReturnValue(db)

  return { bookings, webhookEvents }
}

describe('POST /api/stripe/webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetStripeConfig.mockReturnValue({
      secretKey: 'sk_test',
      priceId: 'price_1',
      couponId: 'coupon_1',
      webhookSecret: 'whsec_1',
    })
    mockConstructEvent.mockReturnValue(completedEvent)
    setupDb()
  })

  describe('authentication', () => {
    it('rejects a missing signature header', async () => {
      const response = await POST(request('{}', null))

      expect(response.status).toBe(401)
      expect(mockGetAdminClient).not.toHaveBeenCalled()
    })

    it('rejects when verification throws', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature')
      })

      const response = await POST(request())

      expect(response.status).toBe(401)
      expect(mockGetAdminClient).not.toHaveBeenCalled()
    })

    it('verifies against the exact bytes received', async () => {
      // Parsing and re-serialising changes whitespace and key order, and the digest
      // with it — the raw body has to reach constructEvent untouched.
      const raw = '{"id":"evt_1",  "spaced": true}'

      await POST(request(raw))

      expect(mockConstructEvent).toHaveBeenCalledWith(raw, 't=1,v1=abc', 'whsec_1')
    })

    it('fails closed when Stripe is not configured', async () => {
      mockGetStripeConfig.mockReturnValue(null)

      const response = await POST(request())

      expect(response.status).toBe(401)
      expect(mockConstructEvent).not.toHaveBeenCalled()
    })

    it('does not leak the rejection reason', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('Timestamp outside the tolerance zone')
      })

      const body = await (await POST(request())).json()

      expect(body.error).toBe('Invalid signature.')
      expect(JSON.stringify(body)).not.toMatch(/tolerance|timestamp/i)
    })
  })

  describe('processing', () => {
    it('marks the booking paid with the charged amount', async () => {
      const { bookings } = setupDb()

      const response = await POST(request())

      expect(response.status).toBe(200)
      const update = bookings.argsFor('update') as [Record<string, unknown>]
      expect(update[0]).toMatchObject({ status: 'paid', charged_amount_cents: 0 })
      expect(bookings.allFor('eq')).toContainEqual({
        method: 'eq',
        args: ['stripe_session_id', 'cs_1'],
      })
      expect(bookings.allFor('eq')).toContainEqual({ method: 'eq', args: ['id', 'b1'] })
    })

    it('acknowledges event types it does not act on', async () => {
      mockConstructEvent.mockReturnValue({ id: 'evt_2', type: 'payment_intent.created' })

      const response = await POST(request())

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ status: 'ignored' })
    })

    it('skips a replayed event', async () => {
      // Stripe retries aggressively; a replay must not re-run the transition.
      const { bookings } = setupDb(false)

      const response = await POST(request())

      await expect(response.json()).resolves.toMatchObject({ status: 'duplicate' })
      expect(bookings.allFor('update')).toHaveLength(0)
    })

    it('returns 500 so Stripe retries when processing fails', async () => {
      const failing = createQueryBuilderMock({ data: null, error: { message: 'db down' } })
      mockGetAdminClient.mockReturnValue(
        createDbMock((table: string) =>
          table === 'webhook_events'
            ? createQueryBuilderMock({ data: null, error: null })
            : failing
        )
      )

      const response = await POST(request())

      expect(response.status).toBe(500)
    })

    it('releases a claimed event when processing fails so Stripe can retry it', async () => {
      const webhookEvents = createQueryBuilderMock({ data: null, error: null })
      const failing = createQueryBuilderMock({ data: null, error: { message: 'db down' } })
      mockGetAdminClient.mockReturnValue(
        createDbMock((table: string) => (table === 'webhook_events' ? webhookEvents : failing))
      )

      expect((await POST(request())).status).toBe(500)
      expect(webhookEvents.allFor('delete')).toHaveLength(1)
    })
  })
})

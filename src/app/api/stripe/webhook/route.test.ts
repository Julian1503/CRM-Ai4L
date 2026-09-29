/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockGetAdminClient = jest.fn()
const mockConstructEvent = jest.fn()
const mockRetrieve = jest.fn()
const mockGetStripeConfig = jest.fn()
const mockStartIntegrationDelivery = jest.fn().mockResolvedValue('delivery-1')
const mockCompleteIntegrationDelivery = jest.fn().mockResolvedValue(undefined)
const mockProcessNotifications = jest.fn()

jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockGetAdminClient() }))
jest.mock('@/lib/stripe/client', () => ({
  getStripeConfig: () => mockGetStripeConfig(),
  getStripeClient: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    checkout: { sessions: { retrieve: mockRetrieve } },
  }),
}))
jest.mock('@/lib/operations/deliveries', () => ({
  startIntegrationDelivery: (...args: unknown[]) => mockStartIntegrationDelivery(...args),
  completeIntegrationDelivery: (...args: unknown[]) => mockCompleteIntegrationDelivery(...args),
}))
jest.mock('@/lib/booking/notifications', () => ({
  processNotifications: (...args: unknown[]) => mockProcessNotifications(...args),
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
      currency: 'aud',
      metadata: { booking_id: 'b1' },
    },
  },
}

type RpcAnswers = {
  claim?: { outcome: string; claim_token: string | null }
  payment?: string | { error: string }
}

/** The ledger and payment RPCs, answering as the database would. */
function setupDb(answers: RpcAnswers = {}) {
  const rpc = jest.fn(async (fn: string) => {
    if (fn === 'claim_webhook_event') {
      return { data: [answers.claim ?? { outcome: 'claimed', claim_token: 'tok-1' }], error: null }
    }
    if (fn === 'apply_checkout_payment') {
      const payment = answers.payment ?? 'applied'
      return typeof payment === 'string'
        ? { data: payment, error: null }
        : { data: null, error: { message: payment.error } }
    }
    return { data: true, error: null }
  })
  mockGetAdminClient.mockReturnValue({ rpc })
  return { rpc }
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
    mockProcessNotifications.mockResolvedValue({ claimed: 1, sent: 1, skipped: 0, retried: 0 })
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
    it('applies the payment and completes the event in one database call (H10, H11)', async () => {
      const { rpc } = setupDb()

      const response = await POST(request())

      expect(response.status).toBe(200)
      expect(rpc).toHaveBeenCalledWith('apply_checkout_payment', {
        p_booking_id: 'b1',
        p_session_id: 'cs_1',
        p_amount: 0,
        p_currency: 'aud',
        p_provider: 'stripe',
        p_event_id: 'evt_1',
        p_event_token: 'tok-1',
      })
    })

    it('sends the queued confirmation email straight away, but does not depend on it', async () => {
      mockProcessNotifications.mockRejectedValue(new Error('Resend down'))
      jest.spyOn(console, 'error').mockImplementation(() => undefined)

      const response = await POST(request())

      expect(response.status).toBe(200)
      expect(mockProcessNotifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: 1 }))
    })

    it('acknowledges a completed duplicate without touching the booking', async () => {
      const { rpc } = setupDb({ claim: { outcome: 'completed', claim_token: null } })

      const response = await POST(request())

      expect(await response.json()).toEqual({ status: 'duplicate' })
      expect(rpc).not.toHaveBeenCalledWith('apply_checkout_payment', expect.anything())
    })

    it('answers retryable while another delivery is processing the same event', async () => {
      setupDb({ claim: { outcome: 'in_progress', claim_token: null } })

      expect((await POST(request())).status).toBe(503)
    })

    it('treats a repeat of the same checkout as success', async () => {
      setupDb({ payment: 'already_applied' })

      const response = await POST(request())

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ status: 'duplicate' })
    })

    it.each(['mismatch', 'not_found'])('acknowledges and records a %s checkout without retrying', async (outcome) => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      setupDb({ payment: outcome })

      const response = await POST(request())

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'rejected' })
    })

    it('asks Stripe to retry when the booking has not recorded its checkout yet', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const { rpc } = setupDb({ payment: 'not_ready' })

      const response = await POST(request())

      expect(response.status).toBe(500)
      expect(rpc).toHaveBeenCalledWith('complete_webhook_event', expect.objectContaining({ p_status: 'failed_retryable' }))
    })

    it('records a database failure as retryable instead of deleting the claim', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const { rpc } = setupDb({ payment: { error: 'connection reset' } })

      const response = await POST(request())

      expect(response.status).toBe(500)
      expect(rpc).toHaveBeenCalledWith('complete_webhook_event', expect.objectContaining({
        p_event_id: 'evt_1',
        p_token: 'tok-1',
        p_status: 'failed_retryable',
      }))
    })

    it('terminally records a checkout that is not complete', async () => {
      mockConstructEvent.mockReturnValue({
        ...completedEvent,
        data: { object: { ...completedEvent.data.object, status: 'open' } },
      })
      const { rpc } = setupDb()

      const response = await POST(request())

      expect(await response.json()).toEqual({ status: 'rejected' })
      expect(rpc).toHaveBeenCalledWith('complete_webhook_event', expect.objectContaining({ p_status: 'failed_terminal' }))
      expect(rpc).not.toHaveBeenCalledWith('apply_checkout_payment', expect.anything())
    })

    it('acknowledges event types it does not act on', async () => {
      mockConstructEvent.mockReturnValue({ ...completedEvent, type: 'payment_intent.created' })
      const { rpc } = setupDb()

      expect(await (await POST(request())).json()).toMatchObject({ status: 'ignored' })
      expect(rpc).not.toHaveBeenCalled()
    })
  })
})

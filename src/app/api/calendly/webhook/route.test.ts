/**
 * @jest-environment node
 */
import { createHmac } from 'node:crypto'

import { NextRequest } from 'next/server'

const mockGetAdminClient = jest.fn()
const mockStartIntegrationDelivery = jest.fn().mockResolvedValue('delivery-1')
const mockCompleteIntegrationDelivery = jest.fn().mockResolvedValue(undefined)

jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockGetAdminClient() }))
jest.mock('@/lib/operations/deliveries', () => ({
  startIntegrationDelivery: (...args: unknown[]) => mockStartIntegrationDelivery(...args),
  completeIntegrationDelivery: (...args: unknown[]) => mockCompleteIntegrationDelivery(...args),
}))

import { POST } from './route'

const SECRET = 'calendly-signing-key'
const URL_PATH = 'https://crm.example.com/api/calendly/webhook'
const ORIGINAL_ENV = process.env

function sign(body: string, timestamp: number, secret = SECRET): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')
  return `t=${timestamp},v1=${digest}`
}

function request(payload: unknown, options: { signature?: string | null } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = { 'content-type': 'application/json' }

  const signature = options.signature === undefined ? sign(body, timestamp) : options.signature
  if (signature !== null) headers['calendly-webhook-signature'] = signature

  return new NextRequest(URL_PATH, { method: 'POST', headers, body })
}

const created = {
  event: 'invitee.created',
  payload: {
    uri: 'https://api.calendly.com/invitees/i1',
    email: 'lead@example.com',
    scheduled_event: {
      uri: 'https://api.calendly.com/events/e1',
      start_time: '2026-09-01T02:00:00.000Z',
    },
    tracking: { utm_content: '11111111-1111-4111-8111-111111111111' },
  },
}

type Answers = { claim?: { outcome: string; claim_token: string | null }; apply?: string | { error: string } }

function setupDb(answers: Answers = {}) {
  const rpc = jest.fn(async (fn: string) => {
    if (fn === 'claim_webhook_event') {
      return { data: [answers.claim ?? { outcome: 'claimed', claim_token: 'tok-1' }], error: null }
    }
    if (fn === 'apply_calendly_event') {
      const apply = answers.apply ?? 'applied'
      return typeof apply === 'string' ? { data: apply, error: null } : { data: null, error: { message: apply.error } }
    }
    return { data: true, error: null }
  })
  mockGetAdminClient.mockReturnValue({ rpc })
  return { rpc }
}

describe('POST /api/calendly/webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...ORIGINAL_ENV, CALENDLY_WEBHOOK_SECRET: SECRET }
    setupDb()
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  describe('authentication', () => {
    it('rejects an unsigned request', async () => {
      const response = await POST(request(created, { signature: null }))

      expect(response.status).toBe(401)
      expect(mockGetAdminClient).not.toHaveBeenCalled()
    })

    it('rejects a forged signature', async () => {
      const body = JSON.stringify(created)
      const timestamp = Math.floor(Date.now() / 1000)

      const response = await POST(
        request(created, { signature: sign(body, timestamp, 'wrong-secret') })
      )

      expect(response.status).toBe(401)
    })

    it('rejects a replayed request', async () => {
      const body = JSON.stringify(created)
      const stale = Math.floor(Date.now() / 1000) - 4000

      const response = await POST(request(created, { signature: sign(body, stale) }))

      expect(response.status).toBe(401)
    })

    it('fails closed when no secret is configured', async () => {
      delete process.env.CALENDLY_WEBHOOK_SECRET

      const response = await POST(request(created))

      expect(response.status).toBe(401)
      expect(mockGetAdminClient).not.toHaveBeenCalled()
    })
  })

  describe('applying events (M4)', () => {
    it('applies a creation and completes the event in the same call', async () => {
      const { rpc } = setupDb()

      const response = await POST(request(created))

      expect(response.status).toBe(200)
      expect(rpc).toHaveBeenCalledWith('apply_calendly_event', {
        p_event: 'invitee.created',
        p_invitee_uri: 'https://api.calendly.com/invitees/i1',
        p_event_uri: 'https://api.calendly.com/events/e1',
        p_scheduled_at: '2026-09-01T02:00:00.000Z',
        p_email: 'lead@example.com',
        p_tracking_booking: '11111111-1111-4111-8111-111111111111',
        p_rescheduled: false,
        p_old_invitee_uri: null,
        p_provider: 'calendly',
        p_event_id: expect.any(String),
        p_event_token: 'tok-1',
      })
    })

    it('passes a reschedule through as a reschedule, not a cancellation', async () => {
      const { rpc } = setupDb()

      await POST(request({
        event: 'invitee.canceled',
        payload: { uri: 'https://api.calendly.com/invitees/old', rescheduled: true, new_invitee: 'https://api.calendly.com/invitees/new' },
      }))

      expect(rpc).toHaveBeenCalledWith('apply_calendly_event', expect.objectContaining({
        p_event: 'invitee.canceled',
        p_rescheduled: true,
      }))
    })

    it('passes the old invitee of a replacement', async () => {
      const { rpc } = setupDb()

      await POST(request({ ...created, payload: { ...created.payload, old_invitee: 'https://api.calendly.com/invitees/old' } }))

      expect(rpc).toHaveBeenCalledWith('apply_calendly_event', expect.objectContaining({
        p_old_invitee_uri: 'https://api.calendly.com/invitees/old',
      }))
    })

    it('ignores a tracking value that is not a booking id', async () => {
      const { rpc } = setupDb()

      await POST(request({ ...created, payload: { ...created.payload, tracking: { utm_content: "b1' or 1=1" } } }))

      expect(rpc).toHaveBeenCalledWith('apply_calendly_event', expect.objectContaining({ p_tracking_booking: null }))
    })

    it('acknowledges an event it had to park for reconciliation', async () => {
      setupDb({ apply: 'unmatched' })

      const response = await POST(request(created))

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ status: 'unmatched' })
    })
  })

  describe('payload handling', () => {
    it('acknowledges an event type it does not handle', async () => {
      const response = await POST(request({ event: 'routing_form_submission.created' }))

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ status: 'ignored' })
    })

    it('rejects a payload with no invitee uri', async () => {
      const response = await POST(request({ event: 'invitee.created', payload: {} }))

      expect(response.status).toBe(400)
    })

    it('rejects malformed JSON', async () => {
      const response = await POST(request('{not json'))

      expect(response.status).toBe(400)
    })
  })

  describe('idempotency (H11)', () => {
    it('acknowledges a completed duplicate', async () => {
      const { rpc } = setupDb({ claim: { outcome: 'completed', claim_token: null } })

      await expect((await POST(request(created))).json()).resolves.toEqual({ status: 'duplicate' })
      expect(rpc).not.toHaveBeenCalledWith('apply_calendly_event', expect.anything())
    })

    it('answers retryable while another delivery holds the event', async () => {
      setupDb({ claim: { outcome: 'in_progress', claim_token: null } })

      expect((await POST(request(created))).status).toBe(503)
    })

    it('records a failure as retryable, so the redelivery can take the event over', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const { rpc } = setupDb({ apply: { error: 'deadlock detected' } })

      const response = await POST(request(created))

      expect(response.status).toBe(500)
      expect(rpc).toHaveBeenCalledWith('complete_webhook_event', expect.objectContaining({
        p_status: 'failed_retryable',
        p_token: 'tok-1',
      }))
    })
  })
})

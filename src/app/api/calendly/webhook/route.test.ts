/**
 * @jest-environment node
 */
import { createHmac } from 'node:crypto'

import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

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
    tracking: { utm_content: 'booking-1' },
  },
}

function setupDb(options: { claimed?: boolean; matched?: boolean } = {}) {
  const { claimed = true, matched = true } = options

  const webhookEvents = createQueryBuilderMock(
    claimed ? { data: null, error: null } : { data: null, error: { code: '23505', message: 'dup' } }
  )
  const bookings = createQueryBuilderMock({ data: matched ? [{ id: 'b1' }] : [], error: null })
  const contacts = createQueryBuilderMock({ data: null, error: null })
  const syncLogs = createQueryBuilderMock({ data: null, error: null })

  const db = createDbMock((table: string) => {
    if (table === 'webhook_events') return webhookEvents
    if (table === 'bookings') return bookings
    if (table === 'sync_logs') return syncLogs
    return contacts
  })

  mockGetAdminClient.mockReturnValue(db)

  return { bookings, syncLogs, webhookEvents }
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

  describe('invitee.created', () => {
    it('attaches the appointment to the booking', async () => {
      const { bookings } = setupDb()

      const response = await POST(request(created))

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ status: 'ok' })

      const update = bookings.argsFor('update') as [Record<string, unknown>]
      expect(update[0]).toMatchObject({
        status: 'booked',
        calendly_invitee_uri: 'https://api.calendly.com/invitees/i1',
        scheduled_at: '2026-09-01T02:00:00.000Z',
      })
    })

    it('uses the tracking parameter to match the exact booking', async () => {
      const { bookings } = setupDb()

      await POST(request(created))

      expect(bookings.allFor('eq')).toContainEqual({ method: 'eq', args: ['id', 'booking-1'] })
    })

    it('logs an unmatched invitee instead of dropping it silently', async () => {
      // The invitee may simply not be in the CRM; that should be visible, not invisible.
      const { syncLogs } = setupDb({ matched: false })

      const response = await POST(
        request({ ...created, payload: { ...created.payload, tracking: {} } })
      )

      await expect(response.json()).resolves.toMatchObject({ status: 'unmatched' })
      expect(syncLogs.allFor('insert')).toHaveLength(1)
    })
  })

  describe('invitee.canceled', () => {
    it('cancels the booking', async () => {
      const { bookings } = setupDb()

      const response = await POST(
        request({ event: 'invitee.canceled', payload: { uri: 'https://api.calendly.com/invitees/i1' } })
      )

      expect(response.status).toBe(200)
      const update = bookings.argsFor('update') as [Record<string, unknown>]
      expect(update[0]).toMatchObject({ status: 'cancelled' })
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

  describe('idempotency', () => {
    it('skips a repeated delivery', async () => {
      const { bookings } = setupDb({ claimed: false })

      const response = await POST(request(created))

      await expect(response.json()).resolves.toMatchObject({ status: 'duplicate' })
      expect(bookings.allFor('update')).toHaveLength(0)
    })

    it('releases a claimed event when processing fails so Calendly can retry it', async () => {
      const webhookEvents = createQueryBuilderMock({ data: null, error: null })
      const failingBookings = createQueryBuilderMock({
        data: null,
        error: { message: 'db down' },
      })
      mockGetAdminClient.mockReturnValue(
        createDbMock((table: string) =>
          table === 'webhook_events' ? webhookEvents : failingBookings
        )
      )

      expect((await POST(request(created))).status).toBe(500)
      expect(webhookEvents.allFor('delete')).toHaveLength(1)
    })
  })
})

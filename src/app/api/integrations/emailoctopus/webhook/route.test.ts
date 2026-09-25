/**
 * @jest-environment node
 */
import { createHmac } from 'node:crypto'

import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetAdminClient = jest.fn()
const mockStartIntegrationDelivery = jest.fn().mockResolvedValue('delivery-1')
const mockCompleteIntegrationDelivery = jest.fn().mockResolvedValue(undefined)

jest.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => mockGetAdminClient(),
}))
jest.mock('@/lib/operations/deliveries', () => ({
  startIntegrationDelivery: (...args: unknown[]) => mockStartIntegrationDelivery(...args),
  completeIntegrationDelivery: (...args: unknown[]) => mockCompleteIntegrationDelivery(...args),
}))

import { POST } from './route'

const SECRET = 'whsec_test'
const URL_PATH = 'https://crm.example.com/api/integrations/emailoctopus/webhook'
const ORIGINAL_ENV = process.env

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

function request(
  payload: unknown,
  options: { signature?: string | null; headers?: Record<string, string> } = {}
) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...options.headers,
  }

  const signature = options.signature === undefined ? `sha256=${sign(body)}` : options.signature

  if (signature !== null) {
    // The provider sends `EmailOctopus-Signature`; header lookup is case-insensitive.
    headers['EmailOctopus-Signature'] = signature
  }

  return new NextRequest(URL_PATH, { method: 'POST', headers, body })
}

/** A delivery is an array of flat events — see help.emailoctopus.com/article/314-webhooks. */
const subscribePayload = [
  {
    id: 'evt-1',
    type: 'contact.created',
    list_id: 'list-1',
    contact_id: 'eo-1',
    contact_email_address: 'grace@example.com',
    contact_status: 'subscribed',
    contact_fields: { FirstName: 'Grace', LastName: 'Hopper' },
    occurred_at: '2026-08-09T10:15:00Z',
  },
]

/**
 * @param options.claimed  false simulates a duplicate delivery.
 * @param options.existing an active contact matching the email, or null.
 */
function setupDb(
  options: { claimed?: boolean; existing?: { id: string } | null; contacts?: unknown[] } = {}
) {
  const { claimed = true, existing = null } = options

  const webhookEvents = createQueryBuilderMock(
    claimed ? { data: null, error: null } : { data: null, error: { code: '23505', message: 'dup' } }
  )
  const contacts = createQueryBuilderMock(
    options.contacts ?? [
      { data: existing, error: null },
      { data: null, error: null },
      { data: { id: 'c-new' }, error: null },
    ]
  )
  const syncLogs = createQueryBuilderMock({ data: null, error: null })

  const db = createDbMock((table: string) => {
    if (table === 'webhook_events') return webhookEvents
    if (table === 'sync_logs') return syncLogs
    return contacts
  })

  mockGetAdminClient.mockReturnValue(db)

  return { db, webhookEvents, contacts, syncLogs }
}

describe('POST emailoctopus webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...ORIGINAL_ENV, EMAILOCTOPUS_WEBHOOK_SECRET: SECRET }
    setupDb()
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  describe('authentication', () => {
    it('accepts the documented EmailOctopus-Signature header', async () => {
      // The handler previously looked for `x-emailoctopus-signature`, which the provider
      // never sends, so every real delivery was answered with a 401.
      const response = await POST(request(subscribePayload))

      expect(response.status).toBe(200)
    })

    it('rejects an unsigned request', async () => {
      const response = await POST(request(subscribePayload, { signature: null }))

      expect(response.status).toBe(401)
      // Nothing may touch the database before the signature is verified.
      expect(mockGetAdminClient).not.toHaveBeenCalled()
    })

    it('rejects a forged signature', async () => {
      const response = await POST(
        request(subscribePayload, { signature: `sha256=${'0'.repeat(64)}` })
      )

      expect(response.status).toBe(401)
      expect(mockGetAdminClient).not.toHaveBeenCalled()
    })

    it('rejects a body tampered with after signing', async () => {
      const original = JSON.stringify(subscribePayload)
      const tampered = JSON.stringify([
        { ...subscribePayload[0], contact_email_address: 'attacker@evil.com' },
      ])

      const response = await POST(
        new NextRequest(URL_PATH, {
          method: 'POST',
          headers: { 'EmailOctopus-Signature': `sha256=${sign(original)}` },
          body: tampered,
        })
      )

      expect(response.status).toBe(401)
    })

    it('fails closed when no secret is configured', async () => {
      // Otherwise a missing env var would silently open the endpoint to anyone.
      delete process.env.EMAILOCTOPUS_WEBHOOK_SECRET

      const response = await POST(request(subscribePayload))

      expect(response.status).toBe(401)
      expect(mockGetAdminClient).not.toHaveBeenCalled()
    })

    it('does not leak the rejection reason to the caller', async () => {
      const response = await POST(request(subscribePayload, { signature: null }))
      const body = await response.json()

      expect(body.error).toBe('Invalid signature.')
      expect(JSON.stringify(body)).not.toMatch(/secret|timestamp|mismatch/i)
    })
  })

  describe('payload handling', () => {
    it('rejects malformed JSON', async () => {
      const response = await POST(request('{not json'))

      expect(response.status).toBe(400)
    })

    it('rejects an envelope that is neither an array nor an object', async () => {
      const response = await POST(request(7))

      expect(response.status).toBe(400)
    })

    it('acknowledges an event type it does not handle', async () => {
      // A 4xx would make EmailOctopus retry something we will never process.
      const response = await POST(
        request([{ type: 'contact.opened', contact_email_address: 'a@example.com' }])
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ status: 'ok', ignored: 1 })
      expect(mockStartIntegrationDelivery).toHaveBeenCalledWith(
        expect.anything(),
        'emailoctopus',
        'batch'
      )
      expect(mockCompleteIntegrationDelivery).toHaveBeenCalledWith(
        expect.anything(),
        'delivery-1',
        expect.objectContaining({ status: 'succeeded', eventCount: 1 })
      )
    })

    it('skips a malformed event without failing the rest of the delivery', async () => {
      // One poison row must not send a 1000-event batch into a ten-day retry loop.
      const { contacts } = setupDb({ existing: null })

      const response = await POST(request([...subscribePayload, { type: 'contact.created' }]))

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ invalid: 1, created: 1 })
      expect(contacts.allFor('insert')).toHaveLength(1)
    })
  })

  describe('subscriber intake', () => {
    it('creates a contact for a brand-new subscriber', async () => {
      // The whole point of scope 3.2. The previous handler updated zero rows and
      // still returned 200, so new signups vanished.
      const { contacts, db } = setupDb({ existing: null })

      const response = await POST(request(subscribePayload))

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ created: 1 })

      const insert = contacts.argsFor('insert') as [Record<string, unknown>]
      expect(insert[0]).toMatchObject({
        email: 'grace@example.com',
        source: 'newsletter',
      })

      // Consent arrives through the attributed RPC rather than inline on the insert.
      expect(db.rpc).toHaveBeenCalledWith(
        'apply_contact_consent',
        expect.objectContaining({ p_newsletter: true, p_source: 'newsletter_webhook' })
      )
    })

    it('updates an existing contact instead of duplicating them', async () => {
      const { contacts } = setupDb({ existing: { id: 'c1' } })

      const response = await POST(request(subscribePayload))

      await expect(response.json()).resolves.toMatchObject({ updated: 1 })
      expect(contacts.allFor('insert')).toHaveLength(0)
    })

    it('unsubscribes on contact.deleted without removing the CRM record', async () => {
      const { contacts, db } = setupDb({ existing: { id: 'c1' } })

      await POST(
        request([
          { id: 'evt-del', type: 'contact.deleted', contact_email_address: 'grace@example.com' },
        ])
      )

      // Removal from the provider's list withdraws both consents — it is the reader
      // asking to stop being emailed, not to stop one stream of it.
      expect(db.rpc).toHaveBeenCalledWith(
        'apply_contact_consent',
        expect.objectContaining({ p_newsletter: false, p_programs: false })
      )
      expect(contacts.allFor('delete')).toHaveLength(0)
    })

    it('writes an entry to the sync log', async () => {
      const { syncLogs } = setupDb({ existing: null })

      await POST(request(subscribePayload))

      const insert = syncLogs.argsFor('insert') as [Array<Record<string, unknown>>]
      expect(String(insert[0][0].event_text)).toContain('grace@example.com')
    })

    it('uses the service-role client, since a webhook has no session', async () => {
      await POST(request(subscribePayload))

      expect(mockGetAdminClient).toHaveBeenCalled()
    })
  })

  describe('batched deliveries', () => {
    it('applies every event in a delivery', async () => {
      // EmailOctopus buffers events for about a minute and sends up to 1000 at once.
      // One lookup per event now: the consent write goes through the RPC rather than
      // through this builder, so the queue no longer interleaves update responses.
      const { db } = setupDb({
        contacts: [
          { data: { id: 'c1', deleted_at: null }, error: null },
          { data: { id: 'c2', deleted_at: null }, error: null },
        ],
      })

      const response = await POST(
        request([
          ...subscribePayload,
          {
            id: 'evt-2',
            type: 'contact.unsubscribed',
            contact_email_address: 'ada@example.com',
            occurred_at: '2026-08-09T10:20:00Z',
          },
        ])
      )

      await expect(response.json()).resolves.toMatchObject({ updated: 2, received: 2 })
      expect(db.rpc).toHaveBeenCalledTimes(2)
    })

    it('logs a batch with a single insert rather than one per event', async () => {
      const { syncLogs } = setupDb({
        contacts: [
          { data: { id: 'c1', deleted_at: null }, error: null },
          { data: null, error: null },
          { data: { id: 'c2', deleted_at: null }, error: null },
          { data: null, error: null },
        ],
      })

      await POST(
        request([
          ...subscribePayload,
          {
            id: 'evt-2',
            type: 'contact.unsubscribed',
            contact_email_address: 'ada@example.com',
          },
        ])
      )

      expect(syncLogs.allFor('insert')).toHaveLength(1)
      const insert = syncLogs.argsFor('insert') as [Array<Record<string, unknown>>]
      expect(insert[0]).toHaveLength(2)
    })
  })

  describe('idempotency', () => {
    it('claims each event on its own id, not the delivery', async () => {
      // Keying on the request would let 999 events ride in on the first one's claim.
      const { webhookEvents } = setupDb()

      await POST(request(subscribePayload))

      const insert = webhookEvents.argsFor('insert') as [Record<string, unknown>]
      expect(insert[0]).toMatchObject({ event_id: 'evt-1', event_type: 'contact.created' })
    })

    it('falls back to a content hash when an event carries no id', async () => {
      const { webhookEvents } = setupDb()

      await POST(
        request([{ type: 'contact.created', contact_email_address: 'grace@example.com' }])
      )

      const insert = webhookEvents.argsFor('insert') as [Record<string, unknown>]
      expect(String(insert[0].event_id)).toMatch(/^sha256:[0-9a-f]{64}$/)
    })

    it('processes a first delivery', async () => {
      const { contacts } = setupDb({ claimed: true, existing: null })

      await POST(request(subscribePayload))

      expect(contacts.allFor('insert')).toHaveLength(1)
    })

    it('skips a repeated delivery without touching contacts', async () => {
      // A retried "unsubscribed" landing after a newer "subscribed" would otherwise
      // silently undo it.
      const { contacts } = setupDb({ claimed: false, existing: null })

      const response = await POST(request(subscribePayload))

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ duplicate: 1 })
      expect(contacts.allFor('insert')).toHaveLength(0)
      expect(contacts.allFor('update')).toHaveLength(0)
    })
  })

  describe('failure handling', () => {
    function setupFailingDb() {
      const webhookEvents = createQueryBuilderMock({ data: null, error: null })
      const failing = createQueryBuilderMock({ data: null, error: { message: 'db down' } })

      mockGetAdminClient.mockReturnValue(
        createDbMock((table: string) => (table === 'webhook_events' ? webhookEvents : failing))
      )

      return { webhookEvents }
    }

    it('returns 500 so the provider retries when processing fails', async () => {
      setupFailingDb()

      const response = await POST(request(subscribePayload))

      expect(response.status).toBe(500)
    })

    it('releases the claim so the retry is not dismissed as a duplicate', async () => {
      // Without this the ledger turns a transient database blip into permanent loss:
      // the event stays claimed, and every retry is skipped.
      const { webhookEvents } = setupFailingDb()

      await POST(request(subscribePayload))

      expect(webhookEvents.allFor('delete')).toHaveLength(1)
      const eqCalls = webhookEvents.allFor('eq').map((call) => call.args)
      expect(eqCalls).toContainEqual(['event_id', 'evt-1'])
    })
  })
})

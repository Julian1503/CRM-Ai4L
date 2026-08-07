/**
 * @jest-environment node
 */
import { createHmac } from 'node:crypto'

import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetAdminClient = jest.fn()

jest.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => mockGetAdminClient(),
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

  const signature =
    options.signature === undefined ? `sha256=${sign(body)}` : options.signature

  if (signature !== null) {
    headers['x-emailoctopus-signature'] = signature
  }

  return new NextRequest(URL_PATH, { method: 'POST', headers, body })
}

const subscribePayload = {
  event: 'contact.subscribed',
  contact: {
    id: 'eo-1',
    email_address: 'grace@example.com',
    fields: { FirstName: 'Grace', LastName: 'Hopper' },
  },
}

/**
 * @param options.claimed  false simulates a duplicate delivery.
 * @param options.existing an active contact matching the email, or null.
 */
function setupDb(options: { claimed?: boolean; existing?: { id: string } | null } = {}) {
  const { claimed = true, existing = null } = options

  const webhookEvents = createQueryBuilderMock(
    claimed ? { data: null, error: null } : { data: null, error: { code: '23505', message: 'dup' } }
  )
  const contacts = createQueryBuilderMock([
    { data: existing, error: null },
    { data: null, error: null },
    { data: { id: 'c-new' }, error: null },
  ])
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
      const tampered = JSON.stringify({
        ...subscribePayload,
        contact: { ...subscribePayload.contact, email_address: 'attacker@evil.com' },
      })

      const response = await POST(
        new NextRequest(URL_PATH, {
          method: 'POST',
          headers: { 'x-emailoctopus-signature': `sha256=${sign(original)}` },
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

    it('rejects a payload with no email', async () => {
      const response = await POST(request({ event: 'contact.subscribed', contact: {} }))

      expect(response.status).toBe(400)
    })

    it('acknowledges an event type it does not handle', async () => {
      // A 4xx would make EmailOctopus retry something we will never process.
      const response = await POST(
        request({ event: 'contact.bounced', contact: { email_address: 'a@example.com' } })
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ status: 'ignored' })
    })
  })

  describe('subscriber intake', () => {
    it('creates a contact for a brand-new subscriber', async () => {
      // The whole point of scope 3.2. The previous handler updated zero rows and
      // still returned 200, so new signups vanished.
      const { contacts } = setupDb({ existing: null })

      const response = await POST(request(subscribePayload))

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ action: 'created' })

      const insert = contacts.argsFor('insert') as [Record<string, unknown>]
      expect(insert[0]).toMatchObject({
        email: 'grace@example.com',
        subscribed_to_newsletter: true,
        source: 'newsletter',
      })
    })

    it('updates an existing contact instead of duplicating them', async () => {
      const { contacts } = setupDb({ existing: { id: 'c1' } })

      const response = await POST(request(subscribePayload))

      await expect(response.json()).resolves.toMatchObject({ action: 'updated' })
      expect(contacts.allFor('insert')).toHaveLength(0)
    })

    it('writes an entry to the sync log', async () => {
      const { syncLogs } = setupDb({ existing: null })

      await POST(request(subscribePayload))

      const insert = syncLogs.argsFor('insert') as [Record<string, unknown>]
      expect(String(insert[0].event_text)).toContain('grace@example.com')
    })

    it('uses the service-role client, since a webhook has no session', async () => {
      await POST(request(subscribePayload))

      expect(mockGetAdminClient).toHaveBeenCalled()
    })
  })

  describe('idempotency', () => {
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
      await expect(response.json()).resolves.toMatchObject({ status: 'duplicate' })
      expect(contacts.allFor('insert')).toHaveLength(0)
      expect(contacts.allFor('update')).toHaveLength(0)
    })

    it('prefers a provider-supplied delivery id', async () => {
      const { webhookEvents } = setupDb()

      await POST(request(subscribePayload, { headers: { 'x-emailoctopus-delivery': 'delivery-9' } }))

      const insert = webhookEvents.argsFor('insert') as [Record<string, unknown>]
      expect(insert[0].event_id).toBe('delivery-9')
    })

    it('falls back to a body hash when no delivery id is sent', async () => {
      const { webhookEvents } = setupDb()

      await POST(request(subscribePayload))

      const insert = webhookEvents.argsFor('insert') as [Record<string, unknown>]
      expect(String(insert[0].event_id)).toMatch(/^sha256:[0-9a-f]{64}$/)
    })
  })

  it('returns 500 so the provider retries when processing fails', async () => {
    const failing = createQueryBuilderMock({ data: null, error: { message: 'db down' } })
    mockGetAdminClient.mockReturnValue(
      createDbMock((table: string) =>
        table === 'webhook_events' ? createQueryBuilderMock({ data: null, error: null }) : failing
      )
    )

    const response = await POST(request(subscribePayload))

    expect(response.status).toBe(500)
  })
})

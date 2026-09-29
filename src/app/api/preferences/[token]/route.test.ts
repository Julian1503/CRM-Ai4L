/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetAdminClient = jest.fn()
const mockProcessOutbox = jest.fn()

// The provider push is covered by src/lib/consent/outbox tests; here only its effect on
// the response matters.
jest.mock('@/lib/consent/outbox', () => ({
  processConsentOutbox: (...args: unknown[]) => mockProcessOutbox(...args),
}))
jest.mock('@/lib/marketing/providers/credentials', () => ({
  loadEmailOctopusCredentials: async () => ({ apiKey: 'k', listId: 'l' }),
}))
jest.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => mockGetAdminClient(),
}))

import { mintPreferencesToken } from '@/lib/preferences/token'

import { POST } from './route'

const ORIGINAL_ENV = process.env
const CONTACT = '3f1c2a44-0000-4000-8000-000000000001'

function setupDb(consent = { subscribed_to_newsletter: false, subscribed_to_programs: true }) {
  const contacts = createQueryBuilderMock({ data: consent, error: null })
  const db = createDbMock(contacts)

  mockGetAdminClient.mockReturnValue(db)
  mockProcessOutbox.mockResolvedValue({ claimed: 1, synced: 1, failed: 0 })

  return { db, contacts }
}

function post(
  token: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  const request = new NextRequest(`https://crm.example.com/api/preferences/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  return POST(request, { params: Promise.resolve({ token }) })
}

describe('POST /api/preferences/[token]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...ORIGINAL_ENV, PREFERENCES_SECRET: 'test-secret' }
    setupDb()
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('applies the consent the reader chose, attributed to the preference centre', async () => {
    const { db } = setupDb()

    const response = await post(mintPreferencesToken(CONTACT), {
      newsletter: false,
      programs: true,
    })

    expect(response.status).toBe(200)
    expect(db.rpc).toHaveBeenCalledWith(
      'apply_contact_consent',
      expect.objectContaining({
        p_contact_id: CONTACT,
        p_newsletter: false,
        p_programs: true,
        p_source: 'preference_center',
      })
    )
  })

  it('keeps the request context as evidence of the withdrawal', async () => {
    // "They unsubscribed" is a claim. "They unsubscribed from this address at this time"
    // is what answers a complaint under the Spam Act.
    const { db } = setupDb()

    await post(
      mintPreferencesToken(CONTACT),
      { newsletter: false },
      { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'Mozilla/5.0 (Test)' }
    )

    const args = db.rpc.mock.calls[0][1] as { p_evidence: Record<string, string> }

    // The client address is the first entry; the rest are proxies.
    expect(args.p_evidence.ip).toBe('203.0.113.7')
    expect(args.p_evidence.user_agent).toBe('Mozilla/5.0 (Test)')
  })

  it('reports the state the database is actually in, not the state requested', async () => {
    // Withdrawing the last consent archives the contact through a trigger, so what is
    // true afterwards is not simply the request applied to the previous state.
    setupDb({ subscribed_to_newsletter: false, subscribed_to_programs: false })

    const response = await post(mintPreferencesToken(CONTACT), {
      newsletter: false,
      programs: false,
    })

    await expect(response.json()).resolves.toEqual({ newsletter: false, programs: false, providerSync: 'done' })
  })

  it('pushes the change to the email provider straight away, for this contact only (H5)', async () => {
    setupDb()

    await post(mintPreferencesToken(CONTACT), { newsletter: false })

    expect(mockProcessOutbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: CONTACT }))
  })

  it('still confirms the saved choice when the provider cannot be reached, and says so', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    setupDb()
    mockProcessOutbox.mockRejectedValue(new Error('provider down'))

    const response = await post(mintPreferencesToken(CONTACT), { newsletter: false })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ providerSync: 'pending' })
  })

  it('leaves a stream alone when the reader said nothing about it', async () => {
    const { db } = setupDb()

    await post(mintPreferencesToken(CONTACT), { newsletter: false })

    expect(db.rpc).toHaveBeenCalledWith(
      'apply_contact_consent',
      expect.objectContaining({ p_newsletter: false, p_programs: null })
    )
  })

  it('refuses a token signed for somebody else', async () => {
    // Editing the contact id inside a valid link is the whole attack: without this the
    // holder of any link could unsubscribe the entire database one id at a time.
    const { db } = setupDb()
    const forged = mintPreferencesToken(CONTACT).replace(
      CONTACT,
      '3f1c2a44-0000-4000-8000-000000000002'
    )

    const response = await post(forged, { newsletter: false })

    expect(response.status).toBe(404)
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('refuses a request that changes nothing', async () => {
    const { db } = setupDb()

    const response = await post(mintPreferencesToken(CONTACT), {})

    expect(response.status).toBe(400)
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('answers a misconfigured server as unavailable, never as an invalid link', async () => {
    // The reader would give up on an unsubscribe that is perfectly valid.
    const token = mintPreferencesToken(CONTACT)
    delete process.env.PREFERENCES_SECRET

    const response = await post(token, { newsletter: false })

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('temporarily unavailable'),
    })
  })

  it('does not cache a response about somebody\'s consent', async () => {
    const response = await post(mintPreferencesToken(CONTACT), { newsletter: false })

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('surfaces a failed write rather than reporting success', async () => {
    const contacts = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(contacts)
    db.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    mockGetAdminClient.mockReturnValue(db)

    const response = await post(mintPreferencesToken(CONTACT), { newsletter: false })

    expect(response.status).toBe(500)
  })
})

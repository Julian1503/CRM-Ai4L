/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { GET, POST } from './route'

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/segments/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
}

function setup(count = 12) {
  const contacts = createQueryBuilderMock({ data: [], error: null, count })
  const db = createDbMock(contacts)
  mockCreateServerClient.mockResolvedValue(db)
  return { db, contacts }
}

describe('POST /api/segments/preview', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setup()
  })

  it('refuses an unauthenticated caller', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await post({ definition: {} })).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns the matching contact count', async () => {
    setup(42)

    await expect((await post({ definition: { state: 'NSW' } })).json()).resolves.toMatchObject({
      total: 42,
    })
  })

  it('estimates the send duration alongside the count', async () => {
    // With a per-contact send against a token bucket, audience size is wall clock.
    // Showing it here means nobody approves a 17-minute send unknowingly.
    setup(10_000)

    const body = await (await post({ definition: {} })).json()

    expect(body.estimatedSendMs).toBeGreaterThan(900_000)
  })

  it('reports zero send time for a small segment that fits in the burst', async () => {
    setup(20)

    const body = await (await post({ definition: {} })).json()

    expect(body.estimatedSendMs).toBe(0)
  })

  it('echoes back that only subscribed contacts are included', async () => {
    // A definition cannot express otherwise; the UI should be able to say so.
    const body = await (await post({ definition: { subscribed: 'false' } })).json()

    expect(body.appliedFilters.subscribedOnly).toBe(true)
  })

  it('flags a segment larger than the send cap', async () => {
    setup(25_000)

    await expect((await post({ definition: {} })).json()).resolves.toMatchObject({
      truncated: true,
    })
  })

  it('reads through the active contacts view', async () => {
    const { db } = setup()

    await post({ definition: {} })

    expect(db.from).toHaveBeenCalledWith('active_contacts')
  })

  it('rejects a non-object body', async () => {
    expect((await post('not json')).status).toBe(400)
  })

  it('surfaces a query failure', async () => {
    const contacts = createQueryBuilderMock({ data: null, error: { message: 'boom' }, count: null })
    mockCreateServerClient.mockResolvedValue(createDbMock(contacts))

    expect((await post({ definition: {} })).status).toBe(500)
  })

  it('answers 405 to a GET, rather than an unhandled error', async () => {
    expect(GET().status).toBe(405)
  })
})

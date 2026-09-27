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
  db.rpc = jest.fn(() => contacts) as never
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

  it('counts each dropdown option alongside the total', async () => {
    // The builder shows these next to the option labels, so an operator can see a
    // job type is empty in the chosen state before saving a segment that sends to
    // nobody.
    const rows = [
      { state: 'NSW', job_type_id: 'elec', status: 'lead' },
      { state: 'NSW', job_type_id: 'plumb', status: 'customer' },
      { state: 'VIC', job_type_id: 'elec', status: 'lead' },
    ]
    const builder = createQueryBuilderMock({ data: rows, error: null, count: rows.length })
    const db = createDbMock(builder)
    db.rpc = jest.fn(() => builder) as never
    mockCreateServerClient.mockResolvedValue(db)

    const body = await (await post({ definition: { state: 'NSW' } })).json()

    expect(body.facets.state).toEqual({ '': 3, NSW: 2, VIC: 1 })
    expect(body.facets.jobType).toEqual({ '': 2, elec: 1, plumb: 1 })
    expect(body.facets.truncated).toBe(false)
  })

  it('reads through segment_contacts(), with no overrides for an unsaved segment', async () => {
    const { db } = setup()

    await post({ definition: {} })

    expect(db.rpc).toHaveBeenCalledWith('segment_contacts', { p_segment_id: null }, { count: 'exact' })
  })

  it('previews an existing segment with its overrides', async () => {
    const { db } = setup()

    await post({ segmentId: 'seg-1', definition: { state: 'VIC' } })

    expect(db.rpc).toHaveBeenCalledWith('segment_contacts', { p_segment_id: 'seg-1' }, { count: 'exact' })
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

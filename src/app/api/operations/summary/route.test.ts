/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { GET } from './route'

const SUMMARY = {
  generatedAt: '2026-08-25T01:00:00.000Z',
  integrations: [
    {
      provider: 'emailoctopus',
      deliveries24h: 2,
      failed24h: 0,
      processing: 0,
      processingStale: 0,
      events24h: 18,
      failedEvents24h: 0,
      lastDeliveryAt: '2026-08-25T00:55:00.000Z',
      lastSuccessAt: '2026-08-25T00:55:01.000Z',
      lastFailureAt: null,
    },
  ],
  campaignSends: { pending: 1, sent: 14, failed: 2, skipped: 0 },
  bookings: {
    pending: 1,
    checkoutStarted: 1,
    paid: 2,
    booked: 7,
    cancelled: 1,
    expired: 0,
  },
  sync: { events24h: 4, failures24h: 0, latestAt: '2026-08-25T00:50:00.000Z' },
}

describe('GET /api/operations/summary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    const db = createDbMock(createQueryBuilderMock())
    db.rpc.mockResolvedValue({ data: SUMMARY, error: null })
    mockCreateServerClient.mockResolvedValue(db)
  })

  it('refuses an unauthenticated request before querying the database', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await GET()

    expect(response.status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns the aggregate from one database RPC', async () => {
    const response = await GET()
    const body = await response.json()
    const db = await mockCreateServerClient.mock.results[0].value

    expect(response.status).toBe(200)
    expect(body.summary).toEqual(SUMMARY)
    expect(db.rpc).toHaveBeenCalledWith('get_operations_summary')
  })

  it('marks the response private and uncacheable', async () => {
    const response = await GET()

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns 500 when the aggregate cannot be read', async () => {
    const db = createDbMock(createQueryBuilderMock())
    db.rpc.mockResolvedValue({ data: null, error: { message: 'function missing' } })
    mockCreateServerClient.mockResolvedValue(db)

    const response = await GET()

    expect(response.status).toBe(500)
  })
})

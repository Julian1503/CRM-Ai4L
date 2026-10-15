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

import { GET } from './route'

const ID = '11111111-1111-4111-8111-111111111111'

const BOOKING = {
  id: ID,
  status: 'booked',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
  expires_at: '2026-10-30T00:00:00.000Z',
  consumed_at: '2026-10-01T05:00:00.000Z',
  stripe_session_id: 'cs_1',
  calendly_event_uri: 'https://api.calendly.com/scheduled_events/e1',
  calendly_invitee_uri: 'https://api.calendly.com/scheduled_events/e1/invitees/i1',
  calendly_superseded_invitees: [],
  scheduled_at: '2026-10-20T01:00:00.000Z',
  cancelled_at: null,
  list_amount_cents: 50_000,
  charged_amount_cents: 0,
  currency: 'AUD',
  contact: { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
  campaign: { id: 'k1', name: 'Spring offer' },
}

function setup(bookingResponse: unknown = { data: BOOKING, error: null }) {
  mockCreateServerClient.mockResolvedValue(
    createDbMock((table: string) =>
      createQueryBuilderMock(table === 'bookings' ? bookingResponse : { data: [], error: null, count: 0 })
    )
  )
}

function get(id = ID) {
  return GET(new NextRequest(`https://crm.example.com/api/bookings/${id}`), { params: Promise.resolve({ id }) })
}

describe('GET /api/bookings/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setup()
  })

  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await get()

    expect(response.status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('answers 404 for an id that is not a UUID, without querying', async () => {
    const response = await get('b1),status.eq.booked')

    expect(response.status).toBe(404)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns the booking, its reasons and its timeline', async () => {
    const response = await get()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.booking.id).toBe(ID)
    expect(body.reasons).toEqual([])
    expect(body.timeline.map((entry: { title: string }) => entry.title)).toEqual([
      'Booking link sent',
      'Checkout opened',
      'Free offer claimed — $0 charged',
      'Consultation scheduled',
    ])
    expect(JSON.stringify(body)).not.toContain('token_hash')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('answers 404 for a booking the session cannot see', async () => {
    setup({ data: null, error: null })
    expect((await get()).status).toBe(404)
  })

  it('surfaces a database failure as a 500', async () => {
    setup({ data: null, error: { message: 'denied' } })
    expect((await get()).status).toBe(500)
  })
})

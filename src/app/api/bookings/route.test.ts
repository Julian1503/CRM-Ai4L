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

const BOOKING = {
  id: 'b1',
  status: 'booked',
  contact_id: 'c1',
  campaign_id: 'camp-1',
  list_amount_cents: 50_000,
  charged_amount_cents: 0,
  currency: 'AUD',
  scheduled_at: '2026-09-01T02:00:00.000Z',
  contact: { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
  campaign: { id: 'camp-1', name: 'RTO winter' },
}

function setup(response: unknown = { data: [BOOKING], error: null, count: 1 }) {
  const bookings = createQueryBuilderMock(response)
  const db = createDbMock(bookings)
  mockCreateServerClient.mockResolvedValue(db)
  return { bookings, db }
}

/**
 * A db whose every `.from()` hands back a fresh builder.
 *
 * The route runs two different queries against `bookings` -- the page and the status
 * counts -- and the counts legitimately call `.eq('status', ...)` six times. Sharing one
 * builder makes those indistinguishable from the caller's own status filter, which is
 * exactly what the filter tests need to tell apart.
 */
function setupPerQuery(response: unknown = { data: [BOOKING], error: null, count: 1 }) {
  const builders: ReturnType<typeof createQueryBuilderMock>[] = []

  mockCreateServerClient.mockResolvedValue(
    createDbMock(() => {
      const builder = createQueryBuilderMock(response)
      builders.push(builder)
      return builder
    })
  )

  /** The page query is the one that is not a `head: true` count. */
  const listBuilder = () =>
    builders.find((builder) => {
      const args = builder.argsFor('select') as [string, { head?: boolean }] | undefined
      return args !== undefined && args[1]?.head !== true
    })

  return { listBuilder }
}

function list(query = '') {
  return GET(new NextRequest(`https://crm.example.com/api/bookings${query}`))
}

describe('GET /api/bookings', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setup()
  })

  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await list()

    expect(response.status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns the bookings with their joined contact and campaign', async () => {
    const response = await list()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.bookings).toEqual([BOOKING])
    expect(body.total).toBe(1)
  })

  it('returns a status breakdown of the whole funnel, not of the page', async () => {
    const response = await list()
    const body = await response.json()

    expect(body.counts).toEqual({
      pending: 1,
      checkout_started: 1,
      paid: 1,
      booked: 1,
      cancelled: 1,
      expired: 1,
    })
  })

  it('never returns the booking token hash to the browser', async () => {
    const response = await list()

    expect(JSON.stringify(await response.json())).not.toContain('token_hash')
  })

  it('is uncacheable, because a booking list is client data', async () => {
    const response = await list()

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('passes a whitelisted status through to the page query', async () => {
    const { listBuilder } = setupPerQuery()

    await list('?status=paid')

    expect(listBuilder()!.allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['status', 'paid'],
    })
  })

  it('ignores a status that is not a real booking status', async () => {
    // The value reaches a query builder, so an unrecognised one must be dropped rather
    // than forwarded -- otherwise a crafted query string filters on whatever it likes.
    const { listBuilder } = setupPerQuery()

    await list('?status=deleted')

    expect(listBuilder()!.allFor('eq')).toHaveLength(0)
  })

  it('scopes to one campaign when asked', async () => {
    const { listBuilder } = setupPerQuery()

    await list('?campaignId=camp-1')

    expect(listBuilder()!.allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['campaign_id', 'camp-1'],
    })
  })

  it('reports the page it served, so the pager cannot drift from the data', async () => {
    const response = await list('?page=2&pageSize=25')
    const body = await response.json()

    expect(body.page).toBe(2)
    expect(body.pageSize).toBe(25)
  })

  it('surfaces a database failure as a 500 rather than an empty funnel', async () => {
    setup({ data: null, error: { message: 'denied' }, count: null })

    const response = await list()

    expect(response.status).toBe(500)
  })
})

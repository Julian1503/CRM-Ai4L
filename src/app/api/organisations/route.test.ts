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

const ORG = { id: 'cccccccc-0000-4000-8000-000000000003', name: 'Acme', industry: 'Health' }

function setup(listResponse: unknown = { data: [ORG], error: null, count: 1 }) {
  const builder = createQueryBuilderMock(listResponse)
  const db = createDbMock(builder)
  mockCreateServerClient.mockResolvedValue(db)
  return { builder, db }
}

function get(query = '') {
  return GET(new NextRequest(`https://crm.example.com/api/organisations${query}`))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSession.mockResolvedValue({ userId: 'u1', email: 'op@example.com', role: 'operator' })
})

describe('GET /api/organisations', () => {
  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await get()).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns a page of organisations with id, name and industry', async () => {
    const { builder } = setup({ data: [ORG], error: null, count: 75 })

    const body = await (await get('?pageSize=50')).json()

    expect(body).toEqual({ organisations: [ORG], total: 75, page: 1, pageSize: 50, hasMore: true })
    expect(builder.argsFor('select')).toEqual(['id, name, industry', { count: 'exact' }])
    expect(builder.argsFor('order')).toEqual(['name', { ascending: true }])
  })

  it('searches by name with LIKE metacharacters escaped', async () => {
    const { builder } = setup()

    await get(`?q=${encodeURIComponent(' a_b ')}`)

    expect(builder.argsFor('ilike')).toEqual(['name', '%a\\_b%'])
  })

  it('returns distinct industries for the industry facet', async () => {
    const { db, builder } = setup()
    db.rpc.mockResolvedValue({ data: ['Construction', 'Health'], error: null })

    const body = await (await get('?facet=industry&q=h')).json()

    expect(body).toEqual({ industries: ['Construction', 'Health'] })
    expect(db.rpc).toHaveBeenCalledWith('organisation_industries', { p_q: 'h', p_limit: 200 })
    expect(builder.calls).toHaveLength(0)
  })

  it('reports a database failure as 500', async () => {
    setup({ data: null, error: { message: 'boom' }, count: null })

    expect((await get()).status).toBe(500)
  })
})

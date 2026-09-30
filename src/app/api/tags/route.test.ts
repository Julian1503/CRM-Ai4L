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

const ORIGIN = 'https://crm.example.com'
const TAG = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'VIP' }

function setup(listResponse: unknown = { data: [TAG], error: null, count: 1 }) {
  const builder = createQueryBuilderMock(listResponse)
  const db = createDbMock(builder)
  mockCreateServerClient.mockResolvedValue(db)
  return { builder, db }
}

function post(body: unknown) {
  return POST(
    new NextRequest(`${ORIGIN}/api/tags`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSession.mockResolvedValue({ userId: 'u1', email: 'op@example.com', role: 'operator' })
})

describe('GET /api/tags', () => {
  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await GET(new NextRequest(`${ORIGIN}/api/tags`))).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns a page of the catalog with its total', async () => {
    const { builder } = setup({ data: [TAG], error: null, count: 120 })

    const body = await (await GET(new NextRequest(`${ORIGIN}/api/tags?page=2&pageSize=50`))).json()

    expect(body).toEqual({ tags: [TAG], total: 120, page: 2, pageSize: 50, hasMore: true })
    expect(builder.argsFor('range')).toEqual([50, 99])
  })

  it('searches by name with LIKE metacharacters escaped', async () => {
    const { builder } = setup()

    await GET(new NextRequest(`${ORIGIN}/api/tags?q=${encodeURIComponent('50%_off')}`))

    expect(builder.argsFor('ilike')).toEqual(['name', '%50\\%\\_off%'])
  })

  it('reports a database failure as 500', async () => {
    setup({ data: null, error: { message: 'boom' }, count: null })

    expect((await GET(new NextRequest(`${ORIGIN}/api/tags`))).status).toBe(500)
  })
})

describe('POST /api/tags', () => {
  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await post({ name: 'VIP' })).status).toBe(401)
  })

  it('creates a tag from a normalised name and answers 201', async () => {
    const { db } = setup()
    db.rpc.mockResolvedValue({ data: { tag: TAG, created: true }, error: null })

    const response = await post({ name: '  VIP  ' })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ tag: TAG, created: true })
    expect(db.rpc).toHaveBeenCalledWith('create_tag', { p_name: 'VIP' })
  })

  it('returns an existing tag with 200 and created: false', async () => {
    const { db } = setup()
    db.rpc.mockResolvedValue({ data: { tag: TAG, created: false }, error: null })

    const response = await post({ name: 'vip' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tag: TAG, created: false })
  })

  it.each([
    ['a malformed body', 'not json'],
    ['no name', {}],
    ['a blank name', { name: '   ' }],
    ['a name over 80 characters', { name: 'x'.repeat(81) }],
  ])('rejects %s with 400 before calling the database', async (_label, body) => {
    const { db } = setup()

    expect((await post(body)).status).toBe(400)
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('maps a database validation error to 400', async () => {
    const { db } = setup()
    db.rpc.mockResolvedValue({ data: null, error: { code: 'CRM07', message: 'A tag name is required.' } })

    expect((await post({ name: 'VIP' })).status).toBe(400)
  })
})

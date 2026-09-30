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

const JOB_TYPE = { id: '11111111-1111-4111-8111-111111111111', name: 'Learning and Development' }

function setup(response: unknown) {
  const builder = createQueryBuilderMock(response)
  const db = createDbMock(builder)
  mockCreateServerClient.mockResolvedValue(db)
  return { builder, db }
}

function list(query = '') {
  return GET(new NextRequest(`https://crm.example.com/api/job-types${query}`))
}

function create(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/job-types', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSession.mockResolvedValue({ userId: 'u1', email: 'op@example.com', role: 'operator' })
})

describe('GET /api/job-types', () => {
  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await list()).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns a page of job types with its pagination envelope', async () => {
    setup({ data: [{ ...JOB_TYPE, created_at: 'x' }], error: null, count: 60 })

    const body = await (await list('?page=1&pageSize=50')).json()

    expect(body).toEqual({
      jobTypes: [JOB_TYPE],
      total: 60,
      page: 1,
      pageSize: 50,
      hasMore: true,
    })
  })

  it('bounds the query to the requested page', async () => {
    const { builder } = setup({ data: [], error: null, count: 0 })

    await list('?page=2&pageSize=20')

    expect(builder.argsFor('range')).toEqual([20, 39])
  })

  it('searches by name with LIKE metacharacters escaped', async () => {
    const { builder } = setup({ data: [], error: null, count: 0 })

    await list('?q=50%25_off')

    expect(builder.argsFor('ilike')).toEqual(['name', '%50\\%\\_off%'])
  })

  it('does not filter without a search term', async () => {
    const { builder } = setup({ data: [], error: null, count: 0 })

    await list('?q=%20%20')

    expect(builder.argsFor('ilike')).toBeUndefined()
  })

  it('reports a database failure as a 500', async () => {
    setup({ data: null, error: { message: 'boom' }, count: null })

    expect((await list()).status).toBe(500)
  })
})

describe('POST /api/job-types', () => {
  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await create({ name: 'RTO' })).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('creates a job type with a cleaned name', async () => {
    const { builder } = setup({ data: JOB_TYPE, error: null })

    const response = await create({ name: '  Learning   and Development ' })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ jobType: JOB_TYPE })
    expect(builder.argsFor('insert')).toEqual([{ name: 'Learning and Development' }])
  })

  it.each([
    ['an empty name', { name: '   ' }],
    ['a missing name', {}],
    ['a non-string name', { name: 42 }],
    ['an over-long name', { name: 'x'.repeat(81) }],
  ])('rejects %s without writing', async (_label, body) => {
    const response = await create(body)

    expect(response.status).toBe(400)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('rejects a malformed body', async () => {
    expect((await create('not json')).status).toBe(400)
  })

  it('reports a duplicate name as a readable 409', async () => {
    setup({ data: null, error: { code: '23505', message: 'duplicate key' } })

    const response = await create({ name: 'learning and development' })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/already exists/)
  })

  it('reports other failures as a 500', async () => {
    setup({ data: null, error: { code: '42501', message: 'denied' } })

    expect((await create({ name: 'RTO' })).status).toBe(500)
  })
})

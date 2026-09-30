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

import { PATCH } from './route'

const ID = 'cccccccc-0000-4000-8000-000000000003'

function context(id: string) {
  // Next.js 16: route params arrive as a Promise.
  return { params: Promise.resolve({ id }) }
}

/** Each await consumes the next response: the conditional update, then (maybe) the re-read. */
function setup(...responses: unknown[]) {
  const builder = createQueryBuilderMock(responses)
  mockCreateServerClient.mockResolvedValue(createDbMock(builder))
  return builder
}

function patch(body: unknown, id = ID) {
  return PATCH(
    new NextRequest(`https://crm.example.com/api/organisations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    context(id)
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSession.mockResolvedValue({ userId: 'u1', email: 'op@example.com', role: 'operator' })
})

describe('PATCH /api/organisations/[id]', () => {
  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await patch({ industry: 'Health', expectedIndustry: null })).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('updates only while the organisation still holds the expected industry', async () => {
    const builder = setup({ data: [{ id: ID, name: 'Acme', industry: 'Health care' }], error: null })

    const response = await patch({ industry: '  Health   care ', expectedIndustry: 'Health' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ organisation: { id: ID, name: 'Acme', industry: 'Health care' } })
    expect(builder.argsFor('update')).toEqual([{ industry: 'Health care' }])
    expect(builder.allFor('eq')).toEqual([
      { method: 'eq', args: ['id', ID] },
      { method: 'eq', args: ['industry', 'Health'] },
    ])
  })

  it('expects "no industry" with IS NULL, not equality', async () => {
    const builder = setup({ data: [{ id: ID, name: 'Acme', industry: 'Health' }], error: null })

    await patch({ industry: 'Health', expectedIndustry: null })

    expect(builder.allFor('is')).toContainEqual({ method: 'is', args: ['industry', null] })
  })

  it('clears the industry with null or a blank value', async () => {
    const builder = setup({ data: [{ id: ID, name: 'Acme', industry: null }], error: null })

    await patch({ industry: '   ', expectedIndustry: 'Health' })

    expect(builder.argsFor('update')).toEqual([{ industry: null }])
  })

  it('answers 409 when someone else changed it first', async () => {
    setup({ data: [], error: null }, { data: { id: ID, name: 'Acme', industry: 'Retail' }, error: null })

    expect((await patch({ industry: 'Health', expectedIndustry: null })).status).toBe(409)
  })

  it('answers 404 when the organisation does not exist', async () => {
    setup({ data: [], error: null }, { data: null, error: null })

    expect((await patch({ industry: 'Health', expectedIndustry: null })).status).toBe(404)
  })

  it('answers 404 for an id that is not a UUID', async () => {
    const builder = setup({ data: [], error: null })

    expect((await patch({ industry: 'Health', expectedIndustry: null }, 'acme')).status).toBe(404)
    expect(builder.calls).toHaveLength(0)
  })

  it.each([
    ['a missing expectedIndustry', { industry: 'Health' }],
    ['a missing industry', { expectedIndustry: null }],
    ['a non-text industry', { industry: 5, expectedIndustry: null }],
    ['a non-text expectedIndustry', { industry: 'Health', expectedIndustry: 5 }],
    ['an industry over 120 characters', { industry: 'x'.repeat(121), expectedIndustry: null }],
  ])('rejects %s with 400', async (_label, body) => {
    const builder = setup({ data: [], error: null })

    expect((await patch(body)).status).toBe(400)
    expect(builder.calls).toHaveLength(0)
  })

  it('reports a database failure as 500', async () => {
    setup({ data: null, error: { message: 'boom' } })

    expect((await patch({ industry: 'Health', expectedIndustry: null })).status).toBe(500)
  })
})

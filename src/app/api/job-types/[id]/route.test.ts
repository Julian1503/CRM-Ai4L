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

const ID = '11111111-1111-4111-8111-111111111111'

function setup(response: unknown) {
  const builder = createQueryBuilderMock(response)
  const db = createDbMock(builder)
  mockCreateServerClient.mockResolvedValue(db)
  return { builder, db }
}

function rename(id: string, body: unknown) {
  return PATCH(
    new NextRequest(`https://crm.example.com/api/job-types/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSession.mockResolvedValue({ userId: 'u1', email: 'op@example.com', role: 'operator' })
})

describe('PATCH /api/job-types/[id]', () => {
  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await rename(ID, { name: 'RTO' })).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('renames in place, keeping the id', async () => {
    const { builder, db } = setup({ data: { id: ID, name: 'RTO' }, error: null })

    const response = await rename(ID, { name: ' RTO ' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ jobType: { id: ID, name: 'RTO' } })
    expect(db.from).toHaveBeenCalledWith('job_types')
    expect(builder.argsFor('update')).toEqual([{ name: 'RTO' }])
    expect(builder.argsFor('eq')).toEqual(['id', ID])
    expect(builder.argsFor('insert')).toBeUndefined()
    expect(builder.argsFor('delete')).toBeUndefined()
  })

  it.each(['not-a-uuid', '1,2', 'x or 1=1'])('rejects the invalid id %s', async (id) => {
    const response = await rename(id, { name: 'RTO' })

    expect(response.status).toBe(400)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty name', { name: '' }],
    ['a whitespace name', { name: '   ' }],
    ['an over-long name', { name: 'x'.repeat(81) }],
  ])('rejects %s', async (_label, body) => {
    expect((await rename(ID, body)).status).toBe(400)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('rejects a malformed body', async () => {
    expect((await rename(ID, '[')).status).toBe(400)
  })

  it('returns 404 when no job type has that id', async () => {
    setup({ data: null, error: null })

    expect((await rename(ID, { name: 'RTO' })).status).toBe(404)
  })

  it('reports a name already held by another job type as a 409', async () => {
    setup({ data: null, error: { code: '23505', message: 'duplicate key' } })

    const response = await rename(ID, { name: 'Learning and Development' })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/already exists/)
  })

  it('reports other failures as a 500', async () => {
    setup({ data: null, error: { code: 'XX000', message: 'boom' } })

    expect((await rename(ID, { name: 'RTO' })).status).toBe(500)
  })
})

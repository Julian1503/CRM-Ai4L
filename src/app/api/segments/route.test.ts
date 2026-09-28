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

const URL_PATH = 'https://crm.example.com/api/segments'

function get(query = '') {
  return GET(new NextRequest(`${URL_PATH}${query}`))
}

function post(body: unknown) {
  return POST(
    new NextRequest(URL_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
}

function setup(insertResult: unknown = { data: { id: 'seg-1' }, error: null }) {
  const segments = createQueryBuilderMock(insertResult)
  const contacts = createQueryBuilderMock({ data: [], error: null, count: 12 })

  const db = createDbMock((table: string) => (table === 'segments' ? segments : contacts))
  db.rpc = jest.fn(() => contacts) as never
  mockCreateServerClient.mockResolvedValue(db)

  return { db, segments, contacts }
}

describe('/api/segments', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setup()
  })

  it('refuses an unauthenticated read', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await get()).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('bounds the listing to one page and reports the total', async () => {
    const { segments } = setup()
    segments.calls.length = 0

    const response = await get()

    // Unbounded, this read would silently stop at PostgREST's 1000-row cap.
    expect(segments.argsFor('range')).toEqual([0, 49])
    expect(segments.argsFor('select')?.[1]).toEqual({ count: 'exact' })
    await expect(response.json()).resolves.toMatchObject({ page: 1, pageSize: 50 })
  })

  it('honours an explicit page and size', async () => {
    const { segments } = setup()
    segments.calls.length = 0

    await get('?page=2&pageSize=10')

    expect(segments.argsFor('range')).toEqual([10, 19])
  })

  it('refuses an unauthenticated write', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await post({ name: 'NSW leads' })).status).toBe(401)
  })

  it('requires a name', async () => {
    expect((await post({ name: '   ' })).status).toBe(400)
  })

  it('rejects a non-object body', async () => {
    const response = await POST(
      new NextRequest(URL_PATH, { method: 'POST', body: 'not json' })
    )

    expect(response.status).toBe(400)
  })

  it('stores a normalised definition', async () => {
    const { segments } = setup()

    await post({ name: 'NSW electricians', definition: { state: 'nsw', jobTypeId: 'job-1' } })

    const insert = segments.argsFor('insert') as [Record<string, unknown>]
    expect(insert[0].definition).toEqual({ state: 'NSW', jobTypeId: 'job-1' })
  })

  it('discards junk from the definition rather than storing it', async () => {
    // A stored definition drives a live query later; unrecognised keys must not
    // survive into the database.
    const { segments } = setup()

    await post({
      name: 'Odd',
      definition: { state: 'VIC', sort: 'password', evil: 'DROP TABLE', pageSize: '999999' },
    })

    const insert = segments.argsFor('insert') as [Record<string, unknown>]
    const definition = insert[0].definition as Record<string, unknown>

    expect(definition).toEqual({ state: 'VIC' })
    expect(definition).not.toHaveProperty('evil')
    expect(definition).not.toHaveProperty('pageSize')
  })

  it('reports the member count of the new segment', async () => {
    setup()

    const response = await post({ name: 'All subscribed' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ memberCount: 12 })
  })

  it('returns 409 for a duplicate name rather than a 500', async () => {
    setup({ data: null, error: { code: '23505', message: 'duplicate key' } })

    const response = await post({ name: 'NSW leads' })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/already exists/i),
    })
  })

  it('surfaces an unexpected failure as 500', async () => {
    setup({ data: null, error: { message: 'connection reset' } })

    expect((await post({ name: 'x' })).status).toBe(500)
  })

  it('lists only live segments by default, and only unremoved archived ones when asked', async () => {
    const { segments } = setup()
    segments.calls.length = 0

    await get()
    expect(segments.allFor('is').map((call) => call.args)).toEqual([['archived_at', null]])

    segments.calls.length = 0
    await get('?archived=true')
    expect(segments.argsFor('not')).toEqual(['archived_at', 'is', null])
    expect(segments.allFor('is').map((call) => call.args)).toEqual([['removed_at', null]])
  })
})

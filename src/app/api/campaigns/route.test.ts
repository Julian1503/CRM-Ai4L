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

function get(query = '') {
  return GET(new NextRequest(`https://crm.example.com/api/campaigns${query}`))
}

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/campaigns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
}

function setup(result: unknown = { data: { id: 'camp-1' }, error: null }) {
  const campaigns = createQueryBuilderMock(result)
  mockCreateServerClient.mockResolvedValue(createDbMock(campaigns))
  return { campaigns }
}

describe('/api/campaigns', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setup()
  })

  it('refuses an unauthenticated read', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await get()).status).toBe(401)
  })

  it('refuses an unauthenticated write', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await post({ name: 'x' })).status).toBe(401)
  })

  it('lists campaigns with their segment', async () => {
    setup({ data: [{ id: 'camp-1' }], error: null, count: 1 })

    const response = await get()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ campaigns: [{ id: 'camp-1' }] })
  })

  it('bounds the listing to one page and reports the total', async () => {
    const { campaigns } = setup({ data: [{ id: 'camp-1' }], error: null, count: 312 })

    const response = await get()

    // Unbounded, this read would silently stop at PostgREST's 1000-row cap.
    expect(campaigns.argsFor('range')).toEqual([0, 49])
    expect(campaigns.argsFor('select')?.[1]).toEqual({ count: 'exact' })
    await expect(response.json()).resolves.toMatchObject({
      page: 1,
      pageSize: 50,
      total: 312,
      pageCount: 7,
      hasMore: true,
    })
  })

  it('honours an explicit page and size', async () => {
    const { campaigns } = setup({ data: [], error: null, count: 312 })

    await get('?page=3&pageSize=25')

    expect(campaigns.argsFor('range')).toEqual([50, 74])
  })

  it('caps a page size a crafted URL asks for', async () => {
    const { campaigns } = setup({ data: [], error: null, count: 5000 })

    await get('?pageSize=99999')

    expect(campaigns.argsFor('range')).toEqual([0, 199])
  })

  it('surfaces a listing failure', async () => {
    setup({ data: null, error: { message: 'boom' } })

    expect((await get()).status).toBe(500)
  })

  it('requires a name', async () => {
    expect((await post({ name: '  ' })).status).toBe(400)
  })

  it('rejects a non-object body', async () => {
    expect((await post('not json')).status).toBe(400)
  })

  it('creates a draft with the supplied details', async () => {
    const { campaigns } = setup()

    await post({
      name: ' August offer ',
      segmentId: 'seg-1',
      providerAutomationId: ' auto-1 ',
      subject: ' Hello ',
    })

    const insert = campaigns.argsFor('insert') as [Record<string, unknown>]
    expect(insert[0]).toMatchObject({
      name: 'August offer',
      segment_id: 'seg-1',
      provider_automation_id: 'auto-1',
      subject: 'Hello',
    })
  })

  it('never accepts a status from the caller', async () => {
    // The database trigger rejects any insert that is not 'draft'; not forwarding it
    // means a hopeful client cannot even try.
    const { campaigns } = setup()

    await post({ name: 'x', status: 'approved' })

    const insert = campaigns.argsFor('insert') as [Record<string, unknown>]
    expect(insert[0]).not.toHaveProperty('status')
  })

  it('keeps only string merge fields', async () => {
    const { campaigns } = setup()

    await post({
      name: 'x',
      mergeFields: { Headline: 'Free consult', Bad: { nested: true }, Count: 5 },
    })

    const insert = campaigns.argsFor('insert') as [Record<string, unknown>]
    expect(insert[0].merge_fields).toEqual({ Headline: 'Free consult' })
  })

  it('defaults merge fields to an empty object', async () => {
    const { campaigns } = setup()

    await post({ name: 'x' })

    const insert = campaigns.argsFor('insert') as [Record<string, unknown>]
    expect(insert[0].merge_fields).toEqual({})
  })

  it('surfaces a creation failure', async () => {
    setup({ data: null, error: { message: 'denied' } })

    expect((await post({ name: 'x' })).status).toBe(500)
  })
})

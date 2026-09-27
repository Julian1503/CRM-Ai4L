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

import { GET as OPTIONS } from '../../options/route'
import { GET } from './route'

function setup(segment: unknown = { definition: { state: 'NSW' } }) {
  const audience = createQueryBuilderMock({
    data: [{ id: 'c1', last_name: 'One', organisation_id: 'org-1', is_included: true }],
    error: null,
    count: 1,
  })
  const tables: Record<string, ReturnType<typeof createQueryBuilderMock>> = {
    segments: createQueryBuilderMock({ data: segment, error: null }),
    organisations: createQueryBuilderMock({ data: [{ id: 'org-1', name: 'Acme' }], error: null }),
    services: createQueryBuilderMock({ data: [{ id: 's1', name: 'Coaching' }], error: null }),
  }
  const db = createDbMock((table: string) => tables[table])
  db.rpc = jest.fn(() => audience) as never
  mockCreateServerClient.mockResolvedValue(db)
  return { db, audience, tables }
}

function members(query = '') {
  return GET(new NextRequest(`https://crm.example.com/api/segments/seg-1/members${query}`), {
    params: Promise.resolve({ id: 'seg-1' }),
  })
}

describe('GET /api/segments/[id]/members', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await members()).status).toBe(401)
  })

  it('lists a page of members with their organisation', async () => {
    setup()

    const body = await (await members()).json()

    expect(body).toMatchObject({
      members: [{ id: 'c1', organisation: 'Acme', is_included: true }],
      total: 1,
      page: 1,
      pageSize: 25,
    })
  })

  it('counts against the stream asked for', async () => {
    const { audience } = setup()

    await members('?stream=programs')

    expect(audience.allFor('eq').map((call) => call.args)).toContainEqual(['subscribed_to_programs', true])
  })

  it('narrows by a search term', async () => {
    const { audience } = setup()

    await members('?q=ada')

    expect(audience.allFor('or').some((call) => String(call.args[0]).includes('"%ada%"'))).toBe(true)
  })

  it('answers 404 for an unknown segment', async () => {
    setup(null)

    expect((await members()).status).toBe(404)
  })
})

describe('GET /api/segments/options', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await OPTIONS(new NextRequest('https://crm.example.com/api/segments/options'))).status).toBe(401)
  })

  it('lists services and sources, and searches organisations by name', async () => {
    const { tables } = setup()

    const body = await (
      await OPTIONS(new NextRequest('https://crm.example.com/api/segments/options?org=ac_me'))
    ).json()

    expect(body).toEqual({
      services: [{ id: 's1', name: 'Coaching' }],
      organisations: [{ id: 'org-1', name: 'Acme' }],
      sources: ['newsletter', 'import', 'manual'],
    })
    // The underscore is a LIKE wildcard; it must be matched literally.
    expect(tables.organisations.argsFor('ilike')).toEqual(['name', '%ac\\_me%'])
  })

  it('does not list organisations until asked', async () => {
    const { tables } = setup()

    const body = await (await OPTIONS(new NextRequest('https://crm.example.com/api/segments/options'))).json()

    expect(body.organisations).toEqual([])
    expect(tables.organisations.argsFor('limit')).toBeUndefined()
  })
})

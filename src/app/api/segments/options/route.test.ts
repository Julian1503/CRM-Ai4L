/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockCreateServerClient() }))

import { GET } from './route'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function setup(tags: unknown = { data: [{ id: A, name: 'VIP' }], error: null }) {
  const builders = {
    services: createQueryBuilderMock({ data: [{ id: 's1', name: 'Audit' }], error: null }),
    organisations: createQueryBuilderMock({ data: [], error: null }),
    tags: createQueryBuilderMock(tags),
  }
  mockCreateServerClient.mockResolvedValue(createDbMock((table: string) => builders[table as keyof typeof builders]))
  return builders
}

const get = (query = '') => GET(new NextRequest(`https://crm.example.com/api/segments/options${query}`))

describe('GET /api/segments/options', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com' })
  })

  it('requires a session', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('labels saved tag ids, ignoring malformed ones', async () => {
    const { tags } = setup()

    const body = await (await get(`?tagIds=${A},junk`)).json()

    expect(body.tags).toEqual([{ id: A, name: 'VIP' }])
    expect(tags.argsFor('in')).toEqual(['id', [A]])
  })

  it('does not read tags when none are asked for, or only malformed ones', async () => {
    const { tags } = setup()

    await expect((await get()).json()).resolves.toMatchObject({ tags: [] })
    await expect((await get('?tagIds=junk')).json()).resolves.toMatchObject({ tags: [] })
    expect(tags.calls).toHaveLength(0)
  })

  it('surfaces a failed tag read', async () => {
    setup({ data: null, error: { message: 'down' } })
    expect((await get(`?tagIds=${A}`)).status).toBe(500)
  })
})

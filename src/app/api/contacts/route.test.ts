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

const CONTACT = {
  id: 'c1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
}

function setup(response: unknown = { data: [CONTACT], error: null, count: 1 }) {
  const contacts = createQueryBuilderMock(response)
  const db = createDbMock(contacts)
  mockCreateServerClient.mockResolvedValue(db)
  return { contacts, db }
}

function list(query = '') {
  return GET(new NextRequest(`https://crm.example.com/api/contacts${query}`))
}

describe('GET /api/contacts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setup()
  })

  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await list()).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns the page with its total', async () => {
    setup({ data: [CONTACT], error: null, count: 3482 })

    const body = await (await list()).json()

    // Every row carries its tags, flattened from the embed; none here.
    expect(body.contacts).toEqual([{ ...CONTACT, tags: [] }])
    expect(body.total).toBe(3482)
  })

  describe('pagination', () => {
    it('defaults to the first page', async () => {
      const body = await (await list()).json()

      expect(body.page).toBe(1)
    })

    it('echoes the requested page and size', async () => {
      setup({ data: [], error: null, count: 500 })

      const body = await (await list('?page=3&pageSize=25')).json()

      expect(body.page).toBe(3)
      expect(body.pageSize).toBe(25)
    })

    it('reports hasMore while pages remain', async () => {
      setup({ data: [CONTACT], error: null, count: 120 })

      const body = await (await list('?page=1&pageSize=50')).json()

      expect(body.hasMore).toBe(true)
    })

    it('reports hasMore false on the last page', async () => {
      setup({ data: [CONTACT], error: null, count: 120 })

      const body = await (await list('?page=3&pageSize=50')).json()

      expect(body.hasMore).toBe(false)
    })

    it('bounds the query rather than returning everything', async () => {
      // The live database holds 5,202 contacts. An unbounded select here is what the
      // Phase 2 rewrite existed to remove.
      const { contacts } = setup()

      await list('?page=2&pageSize=50')

      expect(contacts.argsFor('range')).toEqual([50, 99])
    })
  })

  describe('archive view', () => {
    it('reads the base table when archived contacts are asked for', async () => {
      const { db } = setup()

      await list('?includeArchived=true')

      expect(db.from).toHaveBeenCalledWith('contacts')
    })

    it('reads the active view otherwise, so archived rows cannot leak in', async () => {
      const { db } = setup()

      await list()

      expect(db.from).toHaveBeenCalledWith('active_contacts')
    })
  })

  describe('failures', () => {
    it('surfaces a database error as a 500', async () => {
      setup({ data: null, error: { message: 'relation missing' }, count: null })

      const response = await list()

      expect(response.status).toBe(500)
      expect((await response.json()).error).toContain('relation missing')
    })
  })

  it('is never cacheable — the body is contact data', async () => {
    expect((await list()).headers.get('Cache-Control')).toBe('private, no-store')
  })
})

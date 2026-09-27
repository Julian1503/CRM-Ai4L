/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { GET, PATCH } from './route'

const SEGMENT = { id: 'seg-1', name: 'NSW leads', description: null, definition: { state: 'NSW' } }

type Tables = Record<string, QueryBuilderMock>

function setup(options: {
  segment?: unknown
  locking?: unknown[]
  update?: unknown
  overrides?: unknown[]
} = {}) {
  const tables: Tables = {
    segments: createQueryBuilderMock([
      { data: options.segment === undefined ? SEGMENT : options.segment, error: null },
    ]),
    campaigns: createQueryBuilderMock({ data: options.locking ?? [], error: null }),
    segment_overrides: createQueryBuilderMock({ data: options.overrides ?? [], error: null }),
  }
  if (options.update) tables.segments = createQueryBuilderMock([options.update])

  const audience = createQueryBuilderMock({ data: [], error: null, count: 7 })
  const db = createDbMock((table: string) => tables[table] ?? createQueryBuilderMock({ data: [], error: null }))
  db.rpc = jest.fn(() => audience) as never
  mockCreateServerClient.mockResolvedValue(db)

  return { tables, db }
}

const context = { params: Promise.resolve({ id: 'seg-1' }) }

function patch(body: unknown) {
  return PATCH(
    new NextRequest('https://crm.example.com/api/segments/seg-1', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    context
  )
}

describe('/api/segments/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  describe('GET', () => {
    it('refuses an unauthenticated request', async () => {
      mockGetSession.mockResolvedValue(null)

      expect((await GET(new NextRequest('https://crm.example.com/api/segments/seg-1'), context)).status).toBe(401)
    })

    it('reports reach on both streams, manual decisions and any lock', async () => {
      setup({
        overrides: [{ mode: 'include' }, { mode: 'exclude' }, { mode: 'exclude' }],
        locking: [{ id: 'c1', name: 'August offer', status: 'approved' }],
      })

      const response = await GET(new NextRequest('https://crm.example.com/api/segments/seg-1'), context)
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        segment: { id: 'seg-1' },
        counts: { newsletter: 7, programs: 7 },
        overrides: { included: 1, excluded: 2 },
        lockedBy: [{ name: 'August offer' }],
      })
    })

    it('answers 404 for an unknown segment', async () => {
      setup({ segment: null })

      expect((await GET(new NextRequest('https://crm.example.com/api/segments/nope'), context)).status).toBe(404)
    })
  })

  describe('PATCH', () => {
    it('refuses an unauthenticated request', async () => {
      mockGetSession.mockResolvedValue(null)

      expect((await patch({ name: 'x' })).status).toBe(401)
    })

    it('stores only recognised criteria', async () => {
      const { tables } = setup({ update: { data: SEGMENT, error: null } })

      await patch({ definition: { state: 'vic', serviceId: 'svc-1', evil: 'x', subscribed: 'false' } })

      expect(tables.segments.argsFor('update')?.[0]).toMatchObject({
        definition: { state: 'VIC', serviceId: 'svc-1' },
      })
    })

    it('refuses while an approved or sending campaign uses the segment, naming it', async () => {
      const { tables } = setup({ locking: [{ id: 'c1', name: 'August offer', status: 'sending' }] })

      const response = await patch({ definition: { state: 'VIC' } })

      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('"August offer"')
      expect(tables.segments.argsFor('update')).toBeUndefined()
    })

    it('answers the database lock as 409 when a race gets there first', async () => {
      setup({
        update: {
          data: null,
          error: { code: 'P0001', message: 'Segment is locked by campaign "X", which is approved or sending.' },
        },
      })

      expect((await patch({ name: 'Renamed' })).status).toBe(409)
    })

    it('names a clash when two segments would share a name', async () => {
      setup({ update: { data: null, error: { code: '23505', message: 'duplicate' } } })

      const response = await patch({ name: 'NSW leads' })

      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('NSW leads')
    })

    it('rejects a blank name and an empty patch', async () => {
      setup()

      expect((await patch({ name: '  ' })).status).toBe(400)
      expect((await patch({})).status).toBe(400)
    })
  })
})

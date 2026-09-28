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

const LIVE = { id: 'seg-1', name: 'NSW leads', definition: {}, archived_at: null, removed_at: null }
const ARCHIVED = { ...LIVE, archived_at: '2026-09-01T00:00:00.000Z' }
const REMOVED = { ...ARCHIVED, removed_at: '2026-09-02T00:00:00.000Z' }

function setup(options: {
  segment?: unknown
  update?: unknown
  campaigns?: unknown[]
  schedules?: unknown[]
} = {}) {
  const tables: Record<string, QueryBuilderMock> = {
    segments: createQueryBuilderMock([
      { data: options.segment === undefined ? LIVE : options.segment, error: null },
      options.update ?? { data: { ...LIVE, archived_at: 'now' }, error: null },
    ]),
    campaigns: createQueryBuilderMock({ data: options.campaigns ?? [], error: null }),
    newsletter_schedules: createQueryBuilderMock({ data: options.schedules ?? [], error: null }),
    segment_overrides: createQueryBuilderMock({ data: [], error: null }),
  }
  const db = createDbMock((table: string) => tables[table])
  db.rpc = jest.fn(() => createQueryBuilderMock({ data: [], error: null, count: 0 })) as never
  mockCreateServerClient.mockResolvedValue(db)

  return tables
}

const context = { params: Promise.resolve({ id: 'seg-1' }) }

function patch(body: unknown) {
  return PATCH(
    new NextRequest('https://crm.example.com/api/segments/seg-1', { method: 'PATCH', body: JSON.stringify(body) }),
    context
  )
}

describe('/api/segments/[id] archive and remove', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  it('archives an unused segment', async () => {
    const tables = setup()

    const response = await patch({ archived: true })

    expect(response.status).toBe(200)
    expect(tables.segments.argsFor('update')?.[0]).toMatchObject({ archived_at: expect.any(String) })
  })

  it('refuses to archive a segment in use, naming what uses it', async () => {
    const tables = setup({ campaigns: [{ name: 'August offer' }], schedules: [{ name: 'Monthly' }] })

    const response = await patch({ archived: true })
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toContain('"August offer"')
    expect(body.error).toContain('"Monthly"')
    expect(tables.segments.argsFor('update')).toBeUndefined()
  })

  it('removes by hiding, recording who, never deleting', async () => {
    const tables = setup({ segment: ARCHIVED })

    expect((await patch({ removed: true })).status).toBe(200)
    expect(tables.segments.argsFor('update')?.[0]).toMatchObject({
      archived_at: ARCHIVED.archived_at,
      removed_at: expect.any(String),
      removed_by: 'u1',
    })
    expect(tables.segments.argsFor('delete')).toBeUndefined()
  })

  it('restores an archived segment', async () => {
    const tables = setup({ segment: ARCHIVED })

    expect((await patch({ archived: false })).status).toBe(200)
    expect(tables.segments.argsFor('update')?.[0]).toMatchObject({ archived_at: null })
  })

  it('names the clash when a live segment took the name meanwhile', async () => {
    setup({ segment: ARCHIVED, update: { data: null, error: { code: '23505', message: 'duplicate' } } })

    const response = await patch({ archived: false })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('NSW leads')
  })

  it('answers the database refusal as 409 when a race gets there first', async () => {
    setup({ update: { data: null, error: { code: 'CRM01', message: 'Segment is in use by campaign "X".' } } })

    expect((await patch({ archived: true })).status).toBe(409)
  })

  it('treats a removed segment as not found', async () => {
    setup({ segment: REMOVED })

    expect((await patch({ archived: false })).status).toBe(404)

    setup({ segment: REMOVED })
    expect((await GET(new NextRequest('https://crm.example.com/api/segments/seg-1'), context)).status).toBe(404)
  })

  it('refuses an un-remove and a flag mixed with an edit', async () => {
    setup()

    expect((await patch({ removed: false })).status).toBe(400)
    expect((await patch({ archived: true, name: 'x' })).status).toBe(400)
  })

  it('refuses to edit an archived segment', async () => {
    const tables = setup({ segment: null, update: { data: null, error: null } })
    tables.segments = createQueryBuilderMock({ data: null, error: null })

    const response = await patch({ name: 'Renamed' })

    expect(response.status).toBe(404)
    expect(tables.segments.calls).toEqual(expect.arrayContaining([{ method: 'is', args: ['archived_at', null] }]))
  })

  it('reports what the UI may offer', async () => {
    setup({ campaigns: [{ name: 'August offer' }] })

    const body = await (await GET(new NextRequest('https://crm.example.com/api/segments/seg-1'), context)).json()

    expect(body.lifecycle).toMatchObject({ canArchive: false, canRemove: false })
  })
})

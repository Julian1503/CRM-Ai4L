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

import { DELETE } from './[contactId]/route'
import { GET, POST } from './route'

const CONTACT = { id: 'c1', subscribed_to_newsletter: true, subscribed_to_programs: false }

function setup(options: { locking?: unknown[]; contact?: unknown; overrides?: unknown[]; contacts?: unknown } = {}) {
  const tables: Record<string, QueryBuilderMock> = {
    campaigns: createQueryBuilderMock({ data: options.locking ?? [], error: null }),
    contacts: createQueryBuilderMock(
      options.contacts ?? { data: options.contact === undefined ? CONTACT : options.contact, error: null }
    ),
    segment_overrides: createQueryBuilderMock(
      options.overrides ?? [{ data: { contact_id: 'c1', mode: 'exclude' }, error: null }]
    ),
  }
  mockCreateServerClient.mockResolvedValue(createDbMock((table: string) => tables[table]))
  return tables
}

const context = { params: Promise.resolve({ id: 'seg-1' }) }

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/segments/seg-1/overrides', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    context
  )
}

function remove() {
  return DELETE(
    new NextRequest('https://crm.example.com/api/segments/seg-1/overrides/c1', { method: 'DELETE' }),
    { params: Promise.resolve({ id: 'seg-1', contactId: 'c1' }) }
  )
}

describe('segment overrides', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  it('refuses unauthenticated requests', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await post({ contactId: 'c1', mode: 'exclude' })).status).toBe(401)
    expect((await remove()).status).toBe(401)
  })

  it('records a decision, attributed, replacing any earlier one for that person', async () => {
    const tables = setup()

    const response = await post({ contactId: 'c1', mode: 'exclude', reason: ' Asked not to ' })

    expect(response.status).toBe(200)
    expect(tables.segment_overrides.argsFor('upsert')).toEqual([
      { segment_id: 'seg-1', contact_id: 'c1', mode: 'exclude', reason: 'Asked not to', created_by: 'u1' },
      { onConflict: 'segment_id,contact_id' },
    ])
  })

  it('reports the person’s consent, so an inclusion that cannot reach them is visible', async () => {
    setup()

    const body = await (await post({ contactId: 'c1', mode: 'include' })).json()

    expect(body.consent).toEqual({ newsletter: true, programs: false })
  })

  it('refuses an archived or unknown contact', async () => {
    const tables = setup({ contact: null })

    expect((await post({ contactId: 'gone', mode: 'include' })).status).toBe(404)
    expect(tables.contacts.argsFor('is')).toEqual(['deleted_at', null])
  })

  it('validates the mode', async () => {
    setup()

    expect((await post({ contactId: 'c1', mode: 'maybe' })).status).toBe(400)
    expect((await post({ mode: 'include' })).status).toBe(400)
  })

  it('refuses while the segment is locked by a campaign', async () => {
    const tables = setup({ locking: [{ id: 'k', name: 'August offer', status: 'approved' }] })

    expect((await post({ contactId: 'c1', mode: 'include' })).status).toBe(409)
    expect((await remove()).status).toBe(409)
    expect(tables.segment_overrides.argsFor('upsert')).toBeUndefined()
    expect(tables.segment_overrides.argsFor('delete')).toBeUndefined()
  })

  it('answers the database lock as 409 when a race gets there first', async () => {
    setup({
      overrides: [{ data: null, error: { message: 'Segment is locked by campaign "X"' } }],
    })

    expect((await post({ contactId: 'c1', mode: 'include' })).status).toBe(409)
  })

  it('removes a decision', async () => {
    setup({ overrides: [{ data: [{ contact_id: 'c1' }], error: null }] })

    expect((await remove()).status).toBe(200)
  })

  it('answers 404 when there was no decision to remove', async () => {
    setup({ overrides: [{ data: [], error: null }] })

    expect((await remove()).status).toBe(404)
  })

  it('lists decisions with the people they are about', async () => {
    const tables = setup({
      overrides: [{ data: [{ contact_id: 'c1', mode: 'exclude', reason: null }], error: null, count: 1 }],
      contacts: { data: [{ id: 'c1', email: 'a@example.com' }], error: null },
    })

    const response = await GET(
      new NextRequest('https://crm.example.com/api/segments/seg-1/overrides?mode=exclude'),
      context
    )

    expect(await response.json()).toMatchObject({
      overrides: [{ contact_id: 'c1', contact: { email: 'a@example.com' } }],
      total: 1,
    })
    expect(tables.segment_overrides.allFor('eq').map((call) => call.args)).toContainEqual(['mode', 'exclude'])
  })
})

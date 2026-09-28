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

import { GET, PATCH } from './route'

const LIVE = { id: 'camp-1', status: 'draft', consent_stream: 'newsletter', archived_at: null, removed_at: null }
const ARCHIVED = { ...LIVE, archived_at: '2026-09-01T00:00:00.000Z' }
const REMOVED = { ...ARCHIVED, removed_at: '2026-09-02T00:00:00.000Z' }

function setup(existing: unknown = LIVE, update: unknown = { data: { id: 'camp-1' }, error: null }) {
  const campaigns = createQueryBuilderMock([{ data: existing, error: null }, update])
  mockCreateServerClient.mockResolvedValue(createDbMock(() => campaigns))
  return campaigns
}

const context = { params: Promise.resolve({ id: 'camp-1' }) }

function patch(body: unknown) {
  return PATCH(
    new NextRequest('https://crm.example.com/api/campaigns/camp-1', { method: 'PATCH', body: JSON.stringify(body) }),
    context
  )
}

describe('/api/campaigns/[id] archive and remove', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  it('archives a draft, conditioned on the status it was checked at', async () => {
    const campaigns = setup()

    expect((await patch({ archived: true })).status).toBe(200)
    expect(campaigns.argsFor('update')?.[0]).toMatchObject({ archived_at: expect.any(String) })
    expect(campaigns.allFor('eq').map((call) => call.args)).toContainEqual(['status', 'draft'])
  })

  it.each(['approved', 'sending'])('refuses to archive or remove a %s campaign', async (status) => {
    const campaigns = setup({ ...LIVE, status })

    const archived = await patch({ archived: true })

    expect(archived.status).toBe(409)
    expect((await archived.json()).error).toContain(status)
    expect(campaigns.argsFor('update')).toBeUndefined()

    const again = setup({ ...LIVE, status })

    expect((await patch({ removed: true })).status).toBe(409)
    expect(again.argsFor('update')).toBeUndefined()
  })

  it('removes a sent campaign by hiding it, keeping its history', async () => {
    const campaigns = setup({ ...LIVE, status: 'sent' })

    expect((await patch({ removed: true })).status).toBe(200)
    expect(campaigns.argsFor('update')?.[0]).toMatchObject({
      archived_at: expect.any(String),
      removed_at: expect.any(String),
      removed_by: 'u1',
    })
  })

  it('answers a restore the trigger refuses (its segment is archived) as 409', async () => {
    setup(ARCHIVED, { data: null, error: { code: 'CRM01', message: 'Segment is archived.' } })

    const response = await patch({ archived: false })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('Segment is archived')
  })

  it('answers 409 when the status moved between the check and the write', async () => {
    setup(LIVE, { data: null, error: null })

    expect((await patch({ archived: true })).status).toBe(409)
  })

  it('refuses to edit an archived campaign', async () => {
    const campaigns = setup(ARCHIVED)

    expect((await patch({ name: 'Renamed' })).status).toBe(409)
    expect(campaigns.argsFor('update')).toBeUndefined()
  })

  it('treats a removed campaign as not found', async () => {
    setup(REMOVED)
    expect((await patch({ archived: false })).status).toBe(404)

    setup(REMOVED)
    expect((await GET(new NextRequest('https://crm.example.com/api/campaigns/camp-1'), context)).status).toBe(404)
  })

  it('reports what the UI may offer', async () => {
    setup({ ...LIVE, status: 'approved' })

    const body = await (await GET(new NextRequest('https://crm.example.com/api/campaigns/camp-1'), context)).json()

    expect(body.lifecycle).toMatchObject({ canArchive: false, canRemove: false })
  })
})

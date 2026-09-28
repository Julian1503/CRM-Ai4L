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

import { PATCH } from './route'

const EXISTING = { frequency: 'monthly', timezone: 'Australia/Sydney' }

function setup(existing: unknown = EXISTING, template: unknown = null) {
  const tables: Record<string, QueryBuilderMock> = {
    newsletter_schedules: createQueryBuilderMock([
      { data: existing, error: null },
      { data: { id: 's1' }, error: null },
    ]),
    campaign_templates: createQueryBuilderMock({ data: template, error: null }),
  }
  mockCreateServerClient.mockResolvedValue(createDbMock((table: string) => tables[table]))
  return tables
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest('https://crm.example.com/api/newsletter-schedules/s1', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 's1' }) }
  )
}

describe('PATCH /api/newsletter-schedules/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await patch({ isActive: false })).status).toBe(401)
  })

  it('pauses a schedule', async () => {
    const tables = setup()

    expect((await patch({ isActive: false })).status).toBe(200)
    expect(tables.newsletter_schedules.argsFor('update')?.[0]).toMatchObject({ is_active: false })
  })

  it('does not rewrite the frequency when only the brief changes', async () => {
    const tables = setup()

    await patch({ tone: 'Plain' })

    const update = tables.newsletter_schedules.argsFor('update')?.[0] as Record<string, unknown>
    expect(update).not.toHaveProperty('frequency')
    expect(update).toMatchObject({ tone: 'Plain' })
  })

  it('checks a new first date against the stored frequency', async () => {
    // Monthly on the 30th would drift; the stored frequency is what makes it monthly.
    setup()

    const response = await patch({ firstRunDate: '2026-11-30', sendTime: '08:00' })

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/28th/)
  })

  it('refuses to move a schedule onto a courses template', async () => {
    setup(EXISTING, { consent_stream: 'programs', archived_at: null, provider_automation_id: 'a' })

    expect((await patch({ templateId: 'tpl-courses' })).status).toBe(400)
  })

  it('answers 409 when restoring a schedule whose segment was archived meanwhile', async () => {
    const tables = setup()
    tables.newsletter_schedules = createQueryBuilderMock([
      { data: { id: 's1', name: 'Monthly', archived_at: '2026-09-01T00:00:00.000Z', removed_at: null }, error: null },
      { data: null, error: { code: 'CRM01', message: 'Segment is archived. Choose another segment or restore it first.' } },
    ])

    const response = await patch({ archived: false })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('Segment is archived')
  })

  it('removes a schedule by hiding it, recording who', async () => {
    const tables = setup({ id: 's1', name: 'Monthly', archived_at: null, removed_at: null })

    expect((await patch({ removed: true })).status).toBe(200)
    expect(tables.newsletter_schedules.argsFor('update')?.[0]).toMatchObject({
      archived_at: expect.any(String),
      removed_at: expect.any(String),
      removed_by: 'u1',
    })
  })

  it('treats a removed schedule as not found, for edits too', async () => {
    setup({ ...EXISTING, removed_at: '2026-09-02T00:00:00.000Z' })
    expect((await patch({ tone: 'Plain' })).status).toBe(404)

    setup({ id: 's1', name: 'Monthly', archived_at: 'a', removed_at: 'b' })
    expect((await patch({ archived: false })).status).toBe(404)
  })

  it('answers 404 for an unknown schedule', async () => {
    setup(null)

    expect((await patch({ isActive: false })).status).toBe(404)
  })

  it('rejects a patch that changes nothing', async () => {
    setup()

    expect((await patch({})).status).toBe(400)
  })
})

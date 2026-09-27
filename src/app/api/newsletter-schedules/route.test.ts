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

import { GET, POST } from './route'

const NEWSLETTER_TEMPLATE = {
  consent_stream: 'newsletter',
  archived_at: null,
  provider_automation_id: 'auto-news',
}

const BODY = {
  name: 'Monthly newsletter',
  templateId: 'tpl-1',
  segmentId: 'seg-1',
  frequency: 'monthly',
  firstRunDate: '2026-10-01',
  sendTime: '08:00',
  goal: 'Keep readers informed',
}

function setup(template: unknown = NEWSLETTER_TEMPLATE, schedules: unknown = { data: { id: 's1' }, error: null }) {
  const tables: Record<string, QueryBuilderMock> = {
    campaign_templates: createQueryBuilderMock({ data: template, error: null }),
    newsletter_schedules: createQueryBuilderMock(schedules),
  }
  mockCreateServerClient.mockResolvedValue(createDbMock((table: string) => tables[table]))
  return tables
}

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/newsletter-schedules', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  )
}

describe('/api/newsletter-schedules', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  it('refuses unauthenticated requests', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await GET(new NextRequest('https://crm.example.com/api/newsletter-schedules'))).status).toBe(401)
    expect((await post(BODY)).status).toBe(401)
  })

  it('lists live schedules in next-run order', async () => {
    const tables = setup(undefined, { data: [{ id: 's1' }], error: null })

    const response = await GET(new NextRequest('https://crm.example.com/api/newsletter-schedules'))

    expect(response.status).toBe(200)
    expect(tables.newsletter_schedules.argsFor('is')).toEqual(['archived_at', null])
    expect(tables.newsletter_schedules.argsFor('order')).toEqual(['next_run_at', { ascending: true }])
  })

  it('creates a schedule attributed to its author', async () => {
    const tables = setup()

    const response = await post(BODY)

    expect(response.status).toBe(200)
    expect(tables.newsletter_schedules.argsFor('insert')?.[0]).toMatchObject({
      name: 'Monthly newsletter',
      template_id: 'tpl-1',
      frequency: 'monthly',
      next_run_at: '2026-09-30T22:00:00.000Z',
      created_by: 'u1',
    })
  })

  it('answers invalid input with the reason', async () => {
    setup()

    const response = await post({ ...BODY, frequency: 'daily' })

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/weekly, fortnightly or monthly/)
  })

  it('refuses a courses template, since recurring email is newsletter-only', async () => {
    const tables = setup({ ...NEWSLETTER_TEMPLATE, consent_stream: 'programs' })

    const response = await post(BODY)

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/newsletter only/i)
    expect(tables.newsletter_schedules.argsFor('insert')).toBeUndefined()
  })

  it('refuses a template with no automation', async () => {
    setup({ ...NEWSLETTER_TEMPLATE, provider_automation_id: null })

    expect((await post(BODY)).status).toBe(400)
  })

  it('names a clash when two schedules would share a name', async () => {
    setup(undefined, { data: null, error: { code: '23505', message: 'duplicate' } })

    const response = await post(BODY)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('Monthly newsletter')
  })
})

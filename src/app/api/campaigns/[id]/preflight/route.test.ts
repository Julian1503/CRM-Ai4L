/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()
const mockStatus = jest.fn()
const mockMeasure = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockCreateServerClient() }))
jest.mock('@/lib/marketing/providers/credentials', () => ({ loadEmailOctopusStatus: () => mockStatus() }))
jest.mock('@/lib/marketing/segments', () => ({
  SEGMENT_MEMBER_CAP: 10_000,
  measureSegmentAudience: (...args: unknown[]) => mockMeasure(...args),
}))

import { GET } from './route'

const approved = {
  id: 'camp-1',
  status: 'approved',
  send_run: 1,
  segment_id: 'seg-1',
  provider_automation_id: 'auto-1',
  consent_stream: 'newsletter',
  segment: { definition: {} },
}

function setup(campaign: unknown = approved, run: unknown = null) {
  const campaigns = createQueryBuilderMock({ data: campaign, error: null })
  const runs = createQueryBuilderMock({ data: run, error: null })
  mockCreateServerClient.mockResolvedValue(createDbMock((table: string) => (table === 'campaign_runs' ? runs : campaigns)))
}

function get() {
  return GET(new NextRequest('https://crm.example.com/api/campaigns/camp-1/preflight'), {
    params: Promise.resolve({ id: 'camp-1' }),
  })
}

describe('GET /api/campaigns/[id]/preflight', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })
    mockStatus.mockResolvedValue({ configured: true })
    mockMeasure.mockResolvedValue({ total: 12, truncated: false })
  })

  it('refuses a caller without an approved session', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it.each([
    ['an unknown campaign', null, 404],
    ['a draft', { ...approved, status: 'draft' }, 409],
    ['no segment', { ...approved, segment_id: null }, 409],
    ['no automation', { ...approved, provider_automation_id: '' }, 409],
    ['a deleted segment', { ...approved, segment: null }, 409],
  ])('refuses %s', async (_label, campaign, status) => {
    setup(campaign)
    expect((await get()).status).toBe(status)
  })

  it('refuses when EmailOctopus is not connected', async () => {
    setup()
    mockStatus.mockResolvedValue({ configured: false })
    expect((await get()).status).toBe(409)
  })

  it('reports the live audience before the run is prepared', async () => {
    setup()
    await expect((await get()).json()).resolves.toMatchObject({ ready: true, total: 12, prepared: false })
  })

  it('is not ready when the audience is over the send limit (H7)', async () => {
    setup()
    mockMeasure.mockResolvedValue({ total: 10_500, truncated: true })

    await expect((await get()).json()).resolves.toMatchObject({ ready: false, truncated: true, limit: 10_000 })
  })

  it('reports the prepared snapshot once the run is materialised', async () => {
    setup({ ...approved, status: 'sending' }, { audience_status: 'prepared', prepared_count: 9, expected_count: 10 })

    await expect((await get()).json()).resolves.toMatchObject({ ready: true, total: 9, prepared: true })
    expect(mockMeasure).not.toHaveBeenCalled()
  })
})

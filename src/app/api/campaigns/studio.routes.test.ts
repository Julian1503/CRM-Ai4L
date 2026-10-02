/**
 * @jest-environment node
 *
 * Content Studio campaigns across the campaign routes: content locked to its snapshot,
 * approval gated on the snapshot's validity, preflight extended, and the content read.
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()
const mockResolve = jest.fn()
const mockAssess = jest.fn()
const mockSummary = jest.fn()
const mockStudioPreflight = jest.fn()
const mockCountAudience = jest.fn()
const mockMeasure = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockCreateServerClient() }))
jest.mock('@/lib/marketing/campaignContent', () => {
  const actual = jest.requireActual('@/lib/marketing/campaignContent')
  return {
    ...actual,
    resolveSendContent: (...args: unknown[]) => mockResolve(...args),
    assessContent: (...args: unknown[]) => mockAssess(...args),
    readCampaignContentSummary: (...args: unknown[]) => mockSummary(...args),
  }
})
jest.mock('@/lib/marketing/studioPreflight', () => ({ studioPreflight: (...args: unknown[]) => mockStudioPreflight(...args) }))
jest.mock('@/lib/marketing/runs', () => ({ countCampaignAudience: (...args: unknown[]) => mockCountAudience(...args) }))
jest.mock('@/lib/marketing/segments', () => ({ SEGMENT_MEMBER_CAP: 10_000, measureSegmentAudience: (...args: unknown[]) => mockMeasure(...args) }))
jest.mock('@/lib/marketing/providers/credentials', () => ({
  loadEmailOctopusStatus: async () => ({ configured: true }),
  loadEmailOctopusCredentials: async () => ({ apiKey: 'k', listId: 'l' }),
}))

import { ContentResolutionError } from '@/lib/marketing/campaignContent'

import { GET as getContent } from './[id]/content/route'
import { POST as approve } from './[id]/approve/route'
import { GET as preflight } from './[id]/preflight/route'
import { PATCH } from './[id]/route'

const params = { params: Promise.resolve({ id: 'camp-1' }) }

function mockCampaigns(...responses: unknown[]) {
  const campaigns = createQueryBuilderMock(responses.map((data) => ({ data, error: null })))
  const other = createQueryBuilderMock({ data: null, error: null })
  mockCreateServerClient.mockResolvedValue(createDbMock((table: string) => (table === 'campaigns' ? campaigns : other)))
  return campaigns
}

function json(body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })
  mockResolve.mockResolvedValue({ snapshot: { id: 'snap-1' }, ctaMode: 'none' })
  mockAssess.mockReturnValue([])
  mockCountAudience.mockResolvedValue(10)
  mockMeasure.mockResolvedValue({ total: 10, truncated: false })
})

describe('PATCH a Studio campaign', () => {
  const studio = { id: 'camp-1', status: 'draft', consent_stream: 'newsletter', content_snapshot_id: 'snap-1' }

  it.each([
    ['copy', { mergeFields: { Headline: 'x' } }, /Content Studio/],
    ['the subject', { subject: 'New' }, /Content Studio/],
    ['the automation', { providerAutomationId: 'auto-2' }, /automation are fixed/],
    ['the template', { templateId: 'tpl-2' }, /template and EmailOctopus automation are fixed/],
    ['the automation to empty', { providerAutomationId: '' }, /automation are fixed/],
  ])('refuses to change %s: new content means a new email from the Studio', async (_label, body, message) => {
    const campaigns = mockCampaigns(studio)

    const response = await PATCH(new NextRequest('https://crm/api/campaigns/camp-1', { ...json(body), method: 'PATCH' }), params)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(message) })
    expect(campaigns.argsFor('update')).toBeUndefined()
  })

  it('still lets the name and segment change, and maps the database lock', async () => {
    mockCampaigns(studio, { id: 'camp-1' })
    expect((await PATCH(new NextRequest('https://crm/x', { ...json({ name: 'Renamed' }), method: 'PATCH' }), params)).status).toBe(200)

    const campaigns = createQueryBuilderMock([
      { data: studio, error: null },
      { data: null, error: { code: 'CRM07', message: 'locked' } },
    ])
    mockCreateServerClient.mockResolvedValue(createDbMock(campaigns))
    expect((await PATCH(new NextRequest('https://crm/x', { ...json({ name: 'Again' }), method: 'PATCH' }), params)).status).toBe(409)
  })
})

describe('approving a Studio campaign', () => {
  const inReview = { id: 'camp-1', status: 'in_review', revision: 2, provider_automation_id: 'auto-1', segment_id: 'seg-1', consent_stream: 'newsletter', content_snapshot_id: 'snap-1' }

  it('is refused while its content cannot be sent', async () => {
    const campaigns = mockCampaigns(inReview)
    mockAssess.mockReturnValue(['Field-based Studio emails are switched off.'])

    const response = await approve(new NextRequest('https://crm/x', json({ revision: 2 })), params)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: 'Field-based Studio emails are switched off.' })
    expect(campaigns.argsFor('update')).toBeUndefined()
  })

  it('is refused when its snapshot cannot be read', async () => {
    mockCampaigns(inReview)
    mockResolve.mockRejectedValue(new ContentResolutionError('The snapshot no longer exists.'))

    expect((await approve(new NextRequest('https://crm/x', json({ revision: 2 })), params)).status).toBe(409)
  })

  it('goes through when the snapshot is valid', async () => {
    mockCampaigns(inReview, { id: 'camp-1', status: 'approved' })

    expect((await approve(new NextRequest('https://crm/x', json({ revision: 2 })), params)).status).toBe(200)
    expect(mockAssess).toHaveBeenCalledWith(expect.anything(), { dynamicEnabled: false })
  })
})

describe('preflight for a Studio campaign', () => {
  const approved = {
    id: 'camp-1',
    status: 'approved',
    send_run: 1,
    segment_id: 'seg-1',
    provider_automation_id: 'auto-1',
    consent_stream: 'newsletter',
    content_snapshot_id: 'snap-1',
    segment: { definition: {} },
  }

  it('adds the Studio checks and is not ready while they fail', async () => {
    mockCampaigns(approved)
    mockStudioPreflight.mockResolvedValue({ problems: ['The EmailOctopus list is missing these fields: Courses.'], checklist: ['x'] })

    const body = await (await preflight(new NextRequest('https://crm/x'), params)).json()

    expect(body).toMatchObject({ ready: false, total: 10, studio: { problems: [expect.stringMatching(/Courses/)] } })
    expect(mockStudioPreflight).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      dynamicEnabled: false,
      credentials: { apiKey: 'k', listId: 'l' },
    })
  })

  it('is ready when they pass, and 409s an unreadable snapshot', async () => {
    mockCampaigns(approved)
    mockStudioPreflight.mockResolvedValue({ problems: [], checklist: [] })
    await expect((await preflight(new NextRequest('https://crm/x'), params)).json()).resolves.toMatchObject({ ready: true })

    mockCampaigns(approved)
    mockResolve.mockRejectedValue(new ContentResolutionError('gone'))
    expect((await preflight(new NextRequest('https://crm/x'), params)).status).toBe(409)
  })
})

describe('GET /api/campaigns/[id]/content', () => {
  it('needs a session', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await getContent(new NextRequest('https://crm/x'), params)).status).toBe(401)
  })

  it('answers null for a hand-written campaign and 404 for a removed one', async () => {
    mockCampaigns({ id: 'camp-1', content_snapshot_id: null, removed_at: null })
    await expect((await getContent(new NextRequest('https://crm/x'), params)).json()).resolves.toEqual({ content: null })

    mockCampaigns({ id: 'camp-1', content_snapshot_id: 'snap-1', removed_at: '2026-01-01' })
    expect((await getContent(new NextRequest('https://crm/x'), params)).status).toBe(404)
  })

  it('returns the snapshot summary, and maps failures', async () => {
    mockCampaigns({ id: 'camp-1', content_snapshot_id: 'snap-1', removed_at: null })
    mockSummary.mockResolvedValue({ snapshotId: 'snap-1', sourceItemId: 'item-1' })
    const response = await getContent(new NextRequest('https://crm/x'), params)
    await expect(response.json()).resolves.toEqual({ content: { snapshotId: 'snap-1', sourceItemId: 'item-1' } })
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/)

    mockCampaigns({ id: 'camp-1', content_snapshot_id: 'snap-1', removed_at: null })
    mockSummary.mockRejectedValue(new ContentResolutionError('gone'))
    expect((await getContent(new NextRequest('https://crm/x'), params)).status).toBe(409)

    mockCampaigns({ id: 'camp-1', content_snapshot_id: 'snap-1', removed_at: null })
    mockSummary.mockRejectedValue(new Error('boom'))
    expect((await getContent(new NextRequest('https://crm/x'), params)).status).toBe(500)
  })
})

/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()
const mockSendTest = jest.fn()
const mockList = jest.fn()
const mockStatus = jest.fn()
const mockCredentials = jest.fn()
const mockResolve = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockCreateServerClient() }))
jest.mock('@/lib/marketing/providers/credentials', () => ({ loadEmailOctopusCredentials: () => mockCredentials() }))
jest.mock('@/lib/marketing/providers/emailOctopus', () => ({ createEmailOctopusProvider: () => ({ name: 'eo' }) }))
jest.mock('@/lib/marketing/campaignContent', () => ({ resolveSendContent: (...args: unknown[]) => mockResolve(...args) }))
jest.mock('@/lib/marketing/testSend', () => ({
  ...jest.requireActual('@/lib/marketing/testSend'),
  sendCampaignTest: (...args: unknown[]) => mockSendTest(...args),
  listTestSends: (...args: unknown[]) => mockList(...args),
  readTestStatus: (...args: unknown[]) => mockStatus(...args),
}))

import { GET, POST } from './route'

const params = { params: Promise.resolve({ id: 'camp-1' }) }

function post(body: unknown) {
  return POST(new NextRequest('https://crm.example.com/api/campaigns/camp-1/test-send', { method: 'POST', body: JSON.stringify(body) }), params)
}

function withCampaign(campaign: unknown) {
  mockCreateServerClient.mockResolvedValue(createDbMock(createQueryBuilderMock({ data: campaign, error: null })))
}

describe('/api/campaigns/[id]/test-send', () => {
  const env = process.env.CAMPAIGN_TEST_RECIPIENTS

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.CAMPAIGN_TEST_RECIPIENTS = 'qa@ai4l.com.au, owner@ai4l.com.au'
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })
    mockCredentials.mockResolvedValue({ apiKey: 'k', listId: 'l' })
    withCampaign({ id: 'camp-1', revision: 3, merge_fields: {}, content_snapshot_id: null, removed_at: null })
    mockList.mockResolvedValue([])
    mockStatus.mockResolvedValue({ lastSuccessful: null, currentRevisionTested: false })
  })

  afterAll(() => {
    process.env.CAMPAIGN_TEST_RECIPIENTS = env
  })

  it('requires a session', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await GET(new NextRequest('https://crm/x'), params)).status).toBe(401)
    expect((await post({ recipient: 'qa@ai4l.com.au', revision: 3 })).status).toBe(401)
  })

  it('reports the allowlist, the history and whether this revision was tested', async () => {
    const response = await GET(new NextRequest('https://crm/x'), params)

    expect(response.headers.get('Cache-Control')).toMatch(/no-store/)
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      recipients: ['qa@ai4l.com.au', 'owner@ai4l.com.au'],
      revision: 3,
      testSends: [],
      status: { lastSuccessful: null, currentRevisionTested: false },
    })
    expect(mockStatus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ revision: 3 }), null)
  })

  it('uses the snapshot hash for a Studio campaign, and 404s a removed one', async () => {
    withCampaign({ id: 'camp-1', revision: 3, merge_fields: {}, content_snapshot_id: 'snap-1', removed_at: null })
    mockResolve.mockResolvedValue({ contentHash: 'h' })
    await GET(new NextRequest('https://crm/x'), params)
    expect(mockStatus).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'h')

    withCampaign({ id: 'camp-1', removed_at: 'x' })
    expect((await GET(new NextRequest('https://crm/x'), params)).status).toBe(404)
  })

  it('is disabled without an allowlist', async () => {
    process.env.CAMPAIGN_TEST_RECIPIENTS = ''

    const response = await post({ recipient: 'qa@ai4l.com.au', revision: 3 })
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 'feature_disabled' })
    await expect((await GET(new NextRequest('https://crm/x'), params)).json()).resolves.toMatchObject({ enabled: false, recipients: [] })
    expect(mockSendTest).not.toHaveBeenCalled()
  })

  it.each([
    [{ revision: 3 }],
    [{ recipient: 'qa@ai4l.com.au' }],
    [{ recipient: 'qa@ai4l.com.au', revision: 0 }],
  ])('validates the body %o', async (body) => {
    expect((await post(body)).status).toBe(400)
  })

  it('needs EmailOctopus credentials', async () => {
    mockCredentials.mockResolvedValue(null)
    expect((await post({ recipient: 'qa@ai4l.com.au', revision: 3 })).status).toBe(409)
  })

  it('sends to the allowlist only and returns the record', async () => {
    mockSendTest.mockResolvedValue({ kind: 'done', testSend: { id: 'ts-1', outcome: 'sent' }, note: null })

    const response = await post({ recipient: 'qa@ai4l.com.au', revision: 3 })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ testSend: { id: 'ts-1', outcome: 'sent' }, note: null })
    expect(mockSendTest).toHaveBeenCalledWith(expect.anything(), 'camp-1', expect.objectContaining({
      recipient: 'qa@ai4l.com.au',
      revision: 3,
      allowlist: ['qa@ai4l.com.au', 'owner@ai4l.com.au'],
    }))
  })

  it.each([
    ['not_found', 404],
    ['bad_request', 400],
    ['conflict', 409],
    ['rate_limited', 429],
  ])('maps %s to %i', async (kind, status) => {
    mockSendTest.mockResolvedValue({ kind, message: 'm' })
    expect((await post({ recipient: 'qa@ai4l.com.au', revision: 3 })).status).toBe(status)
  })

  it('answers 500 on unexpected errors', async () => {
    mockSendTest.mockRejectedValue(new Error('boom'))
    expect((await post({ recipient: 'qa@ai4l.com.au', revision: 3 })).status).toBe(500)

    mockList.mockRejectedValue(new Error('down'))
    expect((await GET(new NextRequest('https://crm/x'), params)).status).toBe(500)
  })
})

/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { CAMPAIGN_COPY_FIELDS } from '@/lib/marketing/mergeFields'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()
const mockGenerate = jest.fn()
const mockCreateClient = jest.fn()
const mockResolveMembers = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))
jest.mock('@/lib/marketing/generateCampaign', () => ({
  getAnthropicApiKey: () => process.env.ANTHROPIC_API_KEY?.trim() || null,
  createAnthropicClient: (key: string) => mockCreateClient(key),
  generateCampaignCopy: (...args: unknown[]) => mockGenerate(...args),
}))
jest.mock('@/lib/marketing/segments', () => {
  const actual = jest.requireActual('@/lib/marketing/segments')
  return {
    ...actual,
    measureSegmentAudience: (...args: unknown[]) => mockResolveMembers(...args),
  }
})

import { POST } from './route'

const SEGMENT = {
  name: 'Victorian RTOs',
  description: 'Training organisations in Victoria',
  definition: { state: 'VIC', status: 'prospect' },
}

const DRAFT = {
  id: 'camp-1',
  name: 'Spring outreach',
  status: 'draft',
  notes: null,
  segment_id: 'seg-1',
  segment: SEGMENT,
}

function goodCopy(): Record<string, string> {
  const copy: Record<string, string> = {}
  for (const field of CAMPAIGN_COPY_FIELDS) copy[field.tag] = 'Sound copy'
  return copy
}

function setup(campaign: unknown = DRAFT) {
  const campaigns = createQueryBuilderMock([
    { data: campaign, error: null },
    { data: { id: 'camp-1', status: 'draft' }, error: null },
  ])
  mockCreateServerClient.mockResolvedValue(createDbMock(campaigns))
  return { campaigns }
}

function generate(body: unknown = { campaignId: 'camp-1' }) {
  return POST(
    new NextRequest('https://crm.example.com/api/campaigns/generate', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  )
}

describe('POST /api/campaigns/generate', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    mockGetSession.mockResolvedValue({ userId: 'user-1', email: 'admin@example.com' })
    mockCreateClient.mockReturnValue({ messages: { create: jest.fn() } })
    mockResolveMembers.mockResolvedValue({ members: [], total: 412, truncated: false })
    mockGenerate.mockResolvedValue({
      ok: true,
      copy: goodCopy(),
      attempts: 1,
      usage: { inputTokens: 900, outputTokens: 120 },
    })
    setup()
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalKey
  })

  it('refuses an unauthenticated request before reaching the model', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await generate()).status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('requires a campaign id', async () => {
    const response = await generate({})

    expect(response.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('rejects a malformed body', async () => {
    const response = await POST(
      new NextRequest('https://crm.example.com/api/campaigns/generate', {
        method: 'POST',
        body: 'not json',
        headers: { 'content-type': 'application/json' },
      })
    )

    expect(response.status).toBe(400)
  })

  it('reports a missing API key as a configuration problem, naming the variable', async () => {
    delete process.env.ANTHROPIC_API_KEY

    const response = await generate()

    expect(response.status).toBe(500)
    expect((await response.json()).error).toContain('ANTHROPIC_API_KEY')
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('404s an unknown campaign', async () => {
    setup(null)

    expect((await generate()).status).toBe(404)
  })

  it('generates copy and stores it on the campaign', async () => {
    const { campaigns } = setup()

    const response = await generate()

    expect(response.status).toBe(200)
    const update = campaigns.argsFor('update') as [Record<string, unknown>]
    expect(update[0].merge_fields).toEqual(goodCopy())
  })

  it('mirrors the headline into subject, which the provider template ignores but operators read', async () => {
    const { campaigns } = setup()

    await generate()

    const update = campaigns.argsFor('update') as [Record<string, unknown>]
    expect(update[0].subject).toBe('Sound copy')
  })

  it('returns the campaign to draft so new copy is re-reviewed', async () => {
    const { campaigns } = setup({ ...DRAFT, status: 'in_review' })

    await generate()

    const update = campaigns.argsFor('update') as [Record<string, unknown>]
    expect(update[0].status).toBe('draft')
  })

  it('reports the audience size back so the operator can sanity-check it', async () => {
    const response = await generate()

    expect((await response.json()).audience).toEqual({ size: 412, truncated: false })
  })

  describe('gates', () => {
    it.each(['approved', 'sending', 'sent'])(
      'refuses to rewrite a campaign in "%s"',
      async (status) => {
        setup({ ...DRAFT, status })

        const response = await generate()

        expect(response.status).toBe(409)
        expect(mockGenerate).not.toHaveBeenCalled()
      }
    )

    it('allows a failed campaign to be rewritten', async () => {
      setup({ ...DRAFT, status: 'failed' })

      expect((await generate()).status).toBe(200)
    })

    it('refuses a campaign with no segment, since there is no audience to describe', async () => {
      setup({ ...DRAFT, segment_id: null, segment: null })

      const response = await generate()

      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('segment')
      expect(mockGenerate).not.toHaveBeenCalled()
    })

    it('refuses an empty segment rather than writing to nobody', async () => {
      mockResolveMembers.mockResolvedValue({ members: [], total: 0, truncated: false })

      const response = await generate()

      expect(response.status).toBe(409)
      expect(mockGenerate).not.toHaveBeenCalled()
    })
  })

  describe('brief construction', () => {
    it('tells the model which consent the audience holds', async () => {
      setup({ ...DRAFT, consent_stream: 'programs' })

      await generate()

      const [, brief] = mockGenerate.mock.calls[0]
      expect(brief).toMatchObject({ consentStream: 'programs' })
    })

    it('describes the audience by its filters and its real size', async () => {
      await generate()

      const [, brief] = mockGenerate.mock.calls[0]
      expect(brief).toMatchObject({
        campaignName: 'Spring outreach',
        audience: {
          segmentName: 'Victorian RTOs',
          size: 412,
          state: 'VIC',
          status: 'prospect',
        },
      })
    })

    it('names the job type rather than passing its UUID', async () => {
      // A raw id in the brief is noise that looks like information: it steers nothing
      // and costs tokens.
      const campaigns = createQueryBuilderMock([
        {
          data: {
            ...DRAFT,
            segment: { ...SEGMENT, definition: { jobTypeId: 'jt-1', state: 'VIC' } },
          },
          error: null,
        },
        { data: { name: 'Registered Training Organisation' }, error: null },
        { data: { id: 'camp-1', status: 'draft' }, error: null },
      ])
      mockCreateServerClient.mockResolvedValue(createDbMock(campaigns))

      await generate()

      const [, brief] = mockGenerate.mock.calls[0]
      expect(brief.audience.jobType).toBe('Registered Training Organisation')
    })

    it('omits the job type when the segment does not filter on one', async () => {
      await generate()

      const [, brief] = mockGenerate.mock.calls[0]
      expect(brief.audience.jobType).toBeNull()
    })

    it('passes the messages API, not the whole client', async () => {
      const messages = { create: jest.fn() }
      mockCreateClient.mockReturnValue({ messages })

      await generate()

      expect(mockGenerate.mock.calls[0][0]).toBe(messages)
    })
  })

  describe('failures', () => {
    it('surfaces a generation failure without touching the campaign', async () => {
      const { campaigns } = setup()
      mockGenerate.mockResolvedValue({
        ok: false,
        error: 'The model declined to write this campaign.',
        attempts: 1,
      })

      const response = await generate()

      expect(response.status).toBe(500)
      expect((await response.json()).error).toContain('declined')
      expect(campaigns.allFor('update')).toHaveLength(0)
    })

    it('surfaces a save failure', async () => {
      const campaigns = createQueryBuilderMock([
        { data: DRAFT, error: null },
        { data: null, error: { message: 'row is locked' } },
      ])
      mockCreateServerClient.mockResolvedValue(createDbMock(campaigns))

      const response = await generate()

      expect(response.status).toBe(500)
      expect((await response.json()).error).toContain('row is locked')
    })
  })

  it('never caches a response — it carries campaign copy', async () => {
    const response = await generate()

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

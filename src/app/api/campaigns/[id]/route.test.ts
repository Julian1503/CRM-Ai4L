/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import {
  BOOKING_URL_MERGE_FIELD,
  CAMPAIGN_COPY_FIELDS,
} from '@/lib/marketing/mergeFields'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { GET, PATCH } from './route'

function setup(existing: unknown = { id: 'camp-1', status: 'draft' }) {
  const campaigns = createQueryBuilderMock([
    { data: existing, error: null },
    { data: { id: 'camp-1' }, error: null },
  ])
  mockCreateServerClient.mockResolvedValue(createDbMock(campaigns))
  return { campaigns }
}

function patch(body: unknown, id = 'camp-1') {
  return PATCH(
    new NextRequest(`https://crm.example.com/api/campaigns/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

describe('/api/campaigns/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setup()
  })

  it('refuses an unauthenticated read', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await GET(
      new NextRequest('https://crm.example.com/api/campaigns/camp-1'),
      { params: Promise.resolve({ id: 'camp-1' }) }
    )

    expect(response.status).toBe(401)
  })

  it('refuses an unauthenticated write', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await patch({ name: 'x' })).status).toBe(401)
  })

  it('updates editable fields', async () => {
    const { campaigns } = setup()

    const response = await patch({ name: 'Renamed', providerAutomationId: ' auto-9 ' })

    expect(response.status).toBe(200)
    const update = campaigns.argsFor('update') as [Record<string, unknown>]
    expect(update[0]).toMatchObject({ name: 'Renamed', provider_automation_id: 'auto-9' })
  })

  it('refuses to rewrite settings after approval until the campaign returns to draft', async () => {
    setup({ id: 'camp-1', status: 'approved' })

    const response = await patch({ providerAutomationId: 'auto-10' })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/return.*draft/i),
    })
  })

  it('moves a draft into review', async () => {
    const { campaigns } = setup({ id: 'camp-1', status: 'draft' })

    const response = await patch({ status: 'in_review' })

    expect(response.status).toBe(200)
    const update = campaigns.argsFor('update') as [Record<string, unknown>]
    expect(update[0].status).toBe('in_review')
  })

  it.each(['approved', 'sending', 'sent', 'failed'])(
    'refuses to set status "%s" through a generic edit',
    async (status) => {
      // Approval and sending have dedicated, attributed endpoints. Allowing them here
      // would let an ordinary edit smuggle a campaign past the human gate.
      setup({ id: 'camp-1', status: 'in_review' })

      const response = await patch({ status })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringMatching(/approve or send endpoint/i),
      })
    }
  )

  it('refuses an invalid transition even between patchable statuses', async () => {
    setup({ id: 'camp-1', status: 'sent' })

    expect((await patch({ status: 'draft' })).status).toBe(409)
  })

  it('rejects a body with nothing to update', async () => {
    expect((await patch({ unknownField: 'x' })).status).toBe(400)
  })

  it('rejects a non-object body', async () => {
    const response = await PATCH(
      new NextRequest('https://crm.example.com/api/campaigns/camp-1', {
        method: 'PATCH',
        body: 'not json',
      }),
      { params: Promise.resolve({ id: 'camp-1' }) }
    )

    expect(response.status).toBe(400)
  })

  describe('merge fields', () => {
    function fullCopy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      const copy: Record<string, unknown> = {}
      for (const field of CAMPAIGN_COPY_FIELDS) copy[field.tag] = 'Sound copy'
      return { ...copy, ...overrides }
    }

    it('stores a complete, trimmed set of merge fields', async () => {
      const { campaigns } = setup()

      const response = await patch({ mergeFields: fullCopy({ Headline: '  Trimmed  ' }) })

      expect(response.status).toBe(200)
      const update = campaigns.argsFor('update') as [Record<string, unknown>]
      expect((update[0].merge_fields as Record<string, string>).Headline).toBe('Trimmed')
    })

    it('rejects copy that overruns the template', async () => {
      const headline = CAMPAIGN_COPY_FIELDS.find((field) => field.tag === 'Headline')!

      const response = await patch({
        mergeFields: fullCopy({ Headline: 'x'.repeat(headline.maxLength + 1) }),
      })

      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain('Headline is')
    })

    it('rejects an incomplete set rather than merging a partial update', async () => {
      const copy = fullCopy()
      delete copy.Headline

      const response = await patch({ mergeFields: copy })

      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain('Headline is missing.')
    })

    it('refuses a hand-set booking link, which is minted per recipient', async () => {
      // The same gate the generation path applies. An operator pasting a URL here would
      // give every recipient the same single-use link.
      const response = await patch({
        mergeFields: fullCopy({ [BOOKING_URL_MERGE_FIELD]: 'https://crm.example.com/book/x' }),
      })

      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain(BOOKING_URL_MERGE_FIELD)
    })

    it('does not write merge_fields when the body omits them', async () => {
      const { campaigns } = setup()

      await patch({ name: 'Renamed' })

      const update = campaigns.argsFor('update') as [Record<string, unknown>]
      expect(update[0]).not.toHaveProperty('merge_fields')
    })
  })

  it('returns 404 for an unknown campaign', async () => {
    setup(null)

    expect((await patch({ name: 'x' }, 'missing')).status).toBe(404)
  })
})

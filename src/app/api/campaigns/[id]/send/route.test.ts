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

import { POST } from './route'

const CREDENTIALS = [
  { key: 'emailoctopus_api_key', value: 'eo-key' },
  { key: 'emailoctopus_list_id', value: 'list-1' },
]

const approvedCampaign = {
  id: 'camp-1',
  status: 'approved',
  segment_id: 'seg-1',
  provider_automation_id: 'auto-1',
  merge_fields: {},
}

type Setup = {
  campaign?: unknown
  credentials?: unknown[]
  members?: unknown[]
  memberCount?: number
  pendingAfter?: number
}

function setup(options: Setup = {}) {
  const {
    campaign = approvedCampaign,
    credentials = CREDENTIALS,
    members = [],
    memberCount = members.length,
    pendingAfter = 0,
  } = options

  const campaigns = createQueryBuilderMock([
    { data: campaign, error: null },
    { data: null, error: null },
    { data: null, error: null },
  ])
  const credentialsBuilder = createQueryBuilderMock({ data: credentials, error: null })
  const segments = createQueryBuilderMock({ data: { definition: {} }, error: null })
  const contacts = createQueryBuilderMock({ data: members, error: null, count: memberCount })
  // The queue is consumed one entry per await, so it has to match the actual call
  // sequence. A resumed send (already 'sending') skips prepare, and including a
  // phantom upsert entry would shift every later response by one — which silently
  // turned the remaining-count into undefined.
  const isResuming =
    typeof campaign === 'object' &&
    campaign !== null &&
    (campaign as { status?: string }).status === 'sending'

  const sends = createQueryBuilderMock([
    ...(isResuming ? [] : [{ data: null, error: null }]), // upsert (prepare)
    { data: [], error: null }, // pending list
    { data: null, error: null, count: pendingAfter }, // remaining count
  ])

  const db = createDbMock((table: string) => {
    if (table === 'campaigns') return campaigns
    if (table === 'credentials') return credentialsBuilder
    if (table === 'segments') return segments
    if (table === 'campaign_sends') return sends
    return contacts
  })

  mockCreateServerClient.mockResolvedValue(db)

  return { db, campaigns, sends }
}

function send(id = 'camp-1') {
  return POST(
    new NextRequest(`https://crm.example.com/api/campaigns/${id}/send`, { method: 'POST' }),
    { params: Promise.resolve({ id }) }
  )
}

describe('POST /api/campaigns/[id]/send', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  describe('guards', () => {
    it('refuses an unauthenticated request', async () => {
      setup()
      mockGetSession.mockResolvedValue(null)

      expect((await send()).status).toBe(401)
      expect(mockCreateServerClient).not.toHaveBeenCalled()
    })

    it.each(['draft', 'in_review', 'sent', 'failed'])(
      'refuses to send a campaign in "%s"',
      async (status) => {
        // Sending queues real mail that cannot be recalled, so only an approved
        // campaign may start.
        setup({ campaign: { ...approvedCampaign, status } })

        const response = await send()

        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringMatching(/approved/i),
        })
      }
    )

    it('returns 404 for an unknown campaign', async () => {
      setup({ campaign: null })

      expect((await send('missing')).status).toBe(404)
    })

    it('refuses when the campaign has no segment', async () => {
      setup({ campaign: { ...approvedCampaign, segment_id: null } })

      expect((await send()).status).toBe(409)
    })

    it('refuses when provider credentials are missing', async () => {
      setup({ credentials: [] })

      const response = await send()

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringMatching(/credentials/i),
      })
    })

    it('refuses when the segment currently matches nobody', async () => {
      // Better than reporting a successful send of zero emails.
      setup({ members: [], memberCount: 0 })

      const response = await send()

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringMatching(/no subscribed contacts/i),
      })
    })
  })

  describe('claiming', () => {
    it('moves the campaign to sending, conditioned on it still being approved', async () => {
      // Conditioning the update on 'approved' means a double click cannot start two
      // concurrent fan-outs.
      const { campaigns } = setup({
        members: [{ id: 'c1', email: 'a@example.com', first_name: 'A', last_name: 'B' }],
        memberCount: 1,
      })

      await send()

      const updates = campaigns.allFor('update')
      expect(updates[0].args[0]).toMatchObject({ status: 'sending' })
      expect(campaigns.allFor('eq')).toContainEqual({ method: 'eq', args: ['status', 'approved'] })
    })

    it('does not re-prepare the ledger when resuming a send in progress', async () => {
      // A resumed run must not rebuild the ledger, or it would reset progress.
      const { sends } = setup({ campaign: { ...approvedCampaign, status: 'sending' } })

      await send()

      expect(sends.allFor('upsert')).toHaveLength(0)
    })
  })

  describe('completion', () => {
    it('marks the campaign sent once nothing is pending', async () => {
      const { campaigns } = setup({
        campaign: { ...approvedCampaign, status: 'sending' },
        pendingAfter: 0,
      })

      const response = await send()

      await expect(response.json()).resolves.toMatchObject({ status: 'sent', hasMore: false })
      const finalUpdate = campaigns.allFor('update').at(-1)
      expect(finalUpdate?.args[0]).toMatchObject({ status: 'sent' })
    })

    it('reports more work remaining rather than claiming completion', async () => {
      const response = await (async () => {
        setup({ campaign: { ...approvedCampaign, status: 'sending' }, pendingAfter: 42 })
        return send()
      })()

      await expect(response.json()).resolves.toMatchObject({
        status: 'sending',
        pending: 42,
        hasMore: true,
      })
    })
  })
})

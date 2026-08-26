/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { POST } from './route'

const sentCampaign = { id: 'camp-1', status: 'sent', send_run: 1 }

function setup(options: { campaign?: unknown; claimed?: unknown } = {}) {
  const { campaign = sentCampaign, claimed = { id: 'camp-1', status: 'draft', send_run: 2 } } =
    options

  const campaigns = createQueryBuilderMock([
    { data: campaign, error: null },
    { data: claimed, error: null },
  ])

  mockCreateServerClient.mockResolvedValue(createDbMock(() => campaigns))

  return { campaigns }
}

function reopen(id = 'camp-1') {
  return POST(new Request('https://crm.example.com'), { params: Promise.resolve({ id }) })
}

describe('POST /api/campaigns/[id]/reopen', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  it('refuses an unauthenticated request', async () => {
    setup()
    mockGetSession.mockResolvedValue(null)

    expect((await reopen()).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown campaign', async () => {
    setup({ campaign: null })

    expect((await reopen('missing')).status).toBe(404)
  })

  it.each(['draft', 'in_review', 'approved', 'sending', 'failed'])(
    'refuses to re-open a campaign in "%s"',
    async (status) => {
      // Only a finished send can be repeated. A failed one has "Retry failed", which
      // requeues the recipients that failed rather than emailing everybody twice.
      setup({ campaign: { ...sentCampaign, status } })

      const response = await reopen()

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringMatching(/finished sending/i),
      })
    }
  )

  it('returns the campaign to draft on a new run', async () => {
    const { campaigns } = setup()

    const response = await reopen()

    expect(response.status).toBe(200)
    expect(campaigns.argsFor('update')).toEqual([
      expect.objectContaining({ status: 'draft', send_run: 2 }),
    ])
  })

  it('clears the previous run timestamps and its approval', async () => {
    // A second send has to cross the approval gate again: the segment resolves live, so
    // its audience is whoever matches now, not who was approved last time.
    const { campaigns } = setup()

    await reopen()

    expect(campaigns.argsFor('update')).toEqual([
      expect.objectContaining({
        started_at: null,
        completed_at: null,
        approved_at: null,
        approved_by: null,
      }),
    ])
  })

  it('conditions the write on the campaign still being sent', async () => {
    // Without it a double click advances the run counter twice and strands an empty
    // run in the ledger.
    const { campaigns } = setup()

    await reopen()

    expect(campaigns.allFor('eq')).toContainEqual({ method: 'eq', args: ['status', 'sent'] })
  })

  it('reports a lost race rather than reporting success twice', async () => {
    setup({ claimed: null })

    const response = await reopen()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/already re-opened/i),
    })
  })
})

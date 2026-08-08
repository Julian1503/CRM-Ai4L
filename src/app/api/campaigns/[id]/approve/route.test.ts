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

const approvable = {
  id: 'camp-1',
  status: 'in_review',
  provider_automation_id: 'auto-1',
  segment_id: 'seg-1',
}

function setup(campaign: unknown = approvable) {
  const campaigns = createQueryBuilderMock([
    { data: campaign, error: null },
    { data: { id: 'camp-1', status: 'approved' }, error: null },
  ])
  mockCreateServerClient.mockResolvedValue(createDbMock(campaigns))
  return { campaigns }
}

function approve(id = 'camp-1') {
  return POST(new NextRequest(`https://crm.example.com/api/campaigns/${id}/approve`, {
    method: 'POST',
  }), { params: Promise.resolve({ id }) })
}

describe('POST /api/campaigns/[id]/approve', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'reviewer-1', email: 'admin@example.com' })
    setup()
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await approve()).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('approves a complete campaign under review', async () => {
    const { campaigns } = setup()

    const response = await approve()

    expect(response.status).toBe(200)
    const update = campaigns.argsFor('update') as [Record<string, unknown>]
    expect(update[0].status).toBe('approved')
  })

  it('attributes the approval to the signed-in user', async () => {
    // Approval authorises irreversible sending, so it has to be traceable.
    const { campaigns } = setup()

    await approve()

    const update = campaigns.argsFor('update') as [Record<string, unknown>]
    expect(update[0].approved_by).toBe('reviewer-1')
    expect(update[0].approved_at).toEqual(expect.any(String))
  })

  it('refuses a campaign with no automation id', async () => {
    // EmailOctopus cannot create a campaign via API, so without the automation id
    // approval would produce something that can never send.
    setup({ ...approvable, provider_automation_id: null })

    const response = await approve()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/Started via API/),
    })
  })

  it('refuses a campaign with no segment', async () => {
    setup({ ...approvable, segment_id: null })

    expect((await approve()).status).toBe(409)
  })

  it('refuses to approve straight from draft', async () => {
    setup({ ...approvable, status: 'draft' })

    expect((await approve()).status).toBe(409)
  })

  it('refuses to re-approve something already sent', async () => {
    setup({ ...approvable, status: 'sent' })

    expect((await approve()).status).toBe(409)
  })

  it('guards against a concurrent second approval', async () => {
    // The update is conditioned on the status still being what was read, so a
    // simultaneous approval cannot overwrite the first.
    const { campaigns } = setup()

    await approve()

    expect(campaigns.allFor('eq')).toContainEqual({ method: 'eq', args: ['status', 'in_review'] })
  })

  it('returns 404 for an unknown campaign', async () => {
    setup(null)

    expect((await approve('missing')).status).toBe(404)
  })
})

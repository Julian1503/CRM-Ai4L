/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockCreateServerClient() }))

import { POST } from './route'

function setup(campaign: unknown = { id: 'camp-1', status: 'failed', send_run: 2, removed_at: null }) {
  const db = createDbMock(createQueryBuilderMock({ data: campaign, error: null }))
  db.rpc = jest.fn(async () => ({ data: 3, error: null })) as never
  mockCreateServerClient.mockResolvedValue(db)
  return db
}

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/campaigns/camp-1/uncertain', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'camp-1' }) }
  )
}

describe('POST /api/campaigns/[id]/uncertain (H3)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })
  })

  it('refuses a caller without an approved session', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await post({ resolution: 'sent' })).status).toBe(401)
  })

  it('requires an explicit resolution', async () => {
    setup()
    expect((await post({ resolution: 'maybe' })).status).toBe(400)
  })

  it('settles the current run as the operator decided', async () => {
    const db = setup()

    const response = await post({ resolution: 'retry' })

    expect(await response.json()).toEqual({ resolved: 3, resolution: 'retry' })
    expect(db.rpc).toHaveBeenCalledWith('resolve_uncertain_campaign_sends', {
      p_campaign_id: 'camp-1',
      p_run: 2,
      p_resolution: 'retry',
      p_send_ids: null,
    })
  })

  it('settles only the named recipients when sendIds is given (audit B13)', async () => {
    const db = setup()
    const id = '3f2b6c1e-8a4d-4e7f-9b0a-1c2d3e4f5a6b'

    await post({ resolution: 'sent', sendIds: [id, id] })

    expect(db.rpc).toHaveBeenCalledWith('resolve_uncertain_campaign_sends', {
      p_campaign_id: 'camp-1',
      p_run: 2,
      p_resolution: 'sent',
      p_send_ids: [id],
    })
  })

  it.each([[[]], [['not-a-uuid']], ['3f2b6c1e-8a4d-4e7f-9b0a-1c2d3e4f5a6b']])(
    'refuses a malformed sendIds (%p)',
    async (sendIds) => {
      const db = setup()
      expect((await post({ resolution: 'sent', sendIds })).status).toBe(400)
      expect(db.rpc).not.toHaveBeenCalled()
    }
  )

  it('refuses while the campaign is still sending', async () => {
    setup({ id: 'camp-1', status: 'sending', send_run: 1, removed_at: null })
    expect((await post({ resolution: 'sent' })).status).toBe(409)
  })

  it('answers 404 for a removed campaign', async () => {
    setup({ id: 'camp-1', status: 'failed', send_run: 1, removed_at: 'x' })
    expect((await post({ resolution: 'sent' })).status).toBe(404)
  })
})

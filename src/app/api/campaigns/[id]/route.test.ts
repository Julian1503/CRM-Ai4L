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

  it('returns 404 for an unknown campaign', async () => {
    setup(null)

    expect((await patch({ name: 'x' }, 'missing')).status).toBe(404)
  })
})

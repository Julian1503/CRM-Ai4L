/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()
const mockResolveSegmentPage = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))
jest.mock('@/lib/marketing/segments', () => ({
  resolveSegmentPage: (...args: unknown[]) => mockResolveSegmentPage(...args),
}))

import { GET } from './route'

const campaignRow = {
  id: 'camp-1',
  name: 'August offer',
  segment_id: 'seg-1',
  send_run: 1,
  consent_stream: 'newsletter' as const,
  segment: { name: 'NSW leads', definition: { state: 'NSW' } },
}

function setup(options: { campaign?: unknown; ledger?: unknown[]; ledgerCount?: number } = {}) {
  const { campaign = campaignRow, ledger = [], ledgerCount = 0 } = options

  const campaigns = createQueryBuilderMock({ data: campaign, error: null })
  const sends = createQueryBuilderMock({ data: ledger, error: null, count: ledgerCount })

  mockCreateServerClient.mockResolvedValue(
    createDbMock((table: string) => (table === 'campaigns' ? campaigns : sends))
  )

  return { campaigns, sends }
}

function audience(query = '', id = 'camp-1') {
  return GET(
    new NextRequest(`https://crm.example.com/api/campaigns/${id}/audience${query}`),
    { params: Promise.resolve({ id }) }
  )
}

describe('GET /api/campaigns/[id]/audience', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    mockResolveSegmentPage.mockResolvedValue({
      members: [{ id: 'c1', email: 'a@example.com', first_name: 'Ada', last_name: 'L' }],
      total: 42,
      truncated: false,
      page: 1,
      pageSize: 25,
    })
  })

  it('refuses an unauthenticated request', async () => {
    setup()
    mockGetSession.mockResolvedValue(null)

    expect((await audience()).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown campaign', async () => {
    setup({ campaign: null })

    expect((await audience('', 'missing')).status).toBe(404)
  })

  it('resolves the segment live before anything has been sent', async () => {
    setup()

    const body = await (await audience()).json()

    expect(body).toMatchObject({
      source: 'segment',
      segmentName: 'NSW leads',
      total: 42,
      recipients: [
        {
          contactId: 'c1',
          firstName: 'Ada',
          lastName: 'L',
          email: 'a@example.com',
          status: 'planned',
          error: null,
        },
      ],
    })
  })

  it('reads the ledger once a run exists, with each outcome', async () => {
    // Re-resolving the segment after a send would answer a different question: people
    // unsubscribe and get archived, so "who matches now" is not "who was emailed".
    setup({
      ledgerCount: 2,
      ledger: [
        {
          contact_id: 'c1',
          status: 'sent',
          error: null,
          contact: { id: 'c1', email: 'a@example.com', first_name: 'Ada', last_name: 'L' },
        },
        {
          contact_id: 'c2',
          status: 'failed',
          error: 'contact_id: This value should not be blank.',
          contact: { id: 'c2', email: 'b@example.com', first_name: 'Alan', last_name: 'T' },
        },
      ],
    })

    const body = await (await audience()).json()

    expect(body.source).toBe('ledger')
    expect(body.total).toBe(2)
    expect(body.recipients[1]).toMatchObject({
      email: 'b@example.com',
      status: 'failed',
      error: 'contact_id: This value should not be blank.',
    })
    expect(mockResolveSegmentPage).not.toHaveBeenCalled()
  })

  it('reads the ledger for the run the campaign is on', async () => {
    // A re-sent campaign accumulates runs; showing all of them would list contacts twice.
    const { sends } = setup({
      campaign: { ...campaignRow, send_run: 3 },
      ledgerCount: 1,
      ledger: [{ contact_id: 'c1', status: 'sent', error: null, contact: null }],
    })

    const body = await (await audience()).json()

    expect(sends.allFor('eq')).toContainEqual({ method: 'eq', args: ['run', 3] })
    expect(body.run).toBe(3)
  })

  it('keeps a send in the history when the contact is gone', async () => {
    setup({
      ledgerCount: 1,
      ledger: [{ contact_id: 'c1', status: 'sent', error: null, contact: null }],
    })

    const body = await (await audience()).json()

    expect(body.recipients[0]).toMatchObject({ email: 'Contact removed', status: 'sent' })
  })

  it('pages the request through rather than loading the whole segment', async () => {
    setup()

    await audience('?page=3&pageSize=50')

    // The campaign's own stream is passed through: the audience shown has to be the
    // audience the send would reach, gated on the same consent.
    // By id as well as definition, so the segment's manual overrides apply.
    expect(mockResolveSegmentPage).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'seg-1', definition: { state: 'NSW' } },
      'newsletter',
      { page: 3, pageSize: 50 }
    )
  })

  it('answers with an empty audience when no segment is chosen', async () => {
    setup({ campaign: { ...campaignRow, segment_id: null, segment: null } })

    const body = await (await audience()).json()

    expect(body).toMatchObject({ source: 'segment', recipients: [], total: 0 })
    expect(mockResolveSegmentPage).not.toHaveBeenCalled()
  })
})

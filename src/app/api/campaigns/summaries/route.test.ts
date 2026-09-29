/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockGetSession = jest.fn()
const mockSummaries = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: async () => ({}) }))
jest.mock('@/lib/marketing/sendStatus', () => ({
  MAX_SUMMARY_BATCH: 3,
  readCampaignSendSummaries: (...args: unknown[]) => mockSummaries(...args),
}))

import { GET } from './route'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

function get(ids: string) {
  return GET(new NextRequest(`https://crm.example.com/api/campaigns/summaries?ids=${ids}`))
}

describe('GET /api/campaigns/summaries (A2)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })
    mockSummaries.mockResolvedValue(new Map([[A, { sent: 1 }]]))
  })

  it('refuses a caller without an approved session', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await get(A)).status).toBe(401)
  })

  it('answers every requested campaign in one read', async () => {
    const response = await get(`${A},${B}`)

    expect(await response.json()).toEqual({ summaries: { [A]: { sent: 1 } } })
    expect(mockSummaries).toHaveBeenCalledWith(expect.anything(), [A, B])
  })

  it.each([
    ['no ids', ''],
    ['too many ids', [A, B, A, B].join(',')],
    ['a malformed id', 'not-a-uuid'],
  ])('rejects %s', async (_label, ids) => {
    expect((await get(ids)).status).toBe(400)
    expect(mockSummaries).not.toHaveBeenCalled()
  })
})

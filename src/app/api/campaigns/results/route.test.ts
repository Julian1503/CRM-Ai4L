/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockGetSession = jest.fn()
const mockResults = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: async () => ({}) }))
jest.mock('@/lib/marketing/campaignResults', () => ({
  readCampaignResults: (...args: unknown[]) => mockResults(...args),
}))

import { GET } from './route'

function get(query = '') {
  return GET(new NextRequest(`https://crm.example.com/api/campaigns/results${query}`))
}

describe('GET /api/campaigns/results', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })
    mockResults.mockResolvedValue({ results: [{ id: 'c1' }], total: 26 })
  })

  it('refuses a caller without an approved session', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await get()).status).toBe(401)
    expect(mockResults).not.toHaveBeenCalled()
  })

  it('answers a page of results with the pagination envelope', async () => {
    const response = await get('?page=2')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(
      expect.objectContaining({ results: [{ id: 'c1' }], page: 2, pageSize: 25, total: 26, hasMore: false })
    )
    expect(mockResults).toHaveBeenCalledWith(expect.anything(), { page: 2, pageSize: 25 })
  })

  it('reports a failed read as a server error, not as an empty list', async () => {
    mockResults.mockRejectedValue(new Error('timeout'))

    expect((await get()).status).toBe(500)
  })
})

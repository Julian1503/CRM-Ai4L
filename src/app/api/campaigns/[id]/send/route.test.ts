/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { LedgerWriteError } from '@/lib/marketing/send'

const mockGetSession = jest.fn()
const mockAdvance = jest.fn()
const mockCredentials = jest.fn()
const mockSummary = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: async () => ({}) }))
jest.mock('@/lib/marketing/providers/credentials', () => ({
  loadEmailOctopusCredentials: () => mockCredentials(),
}))
jest.mock('@/lib/marketing/dispatch', () => ({
  advanceCampaignSend: (...args: unknown[]) => mockAdvance(...args),
}))
jest.mock('@/lib/marketing/sendStatus', () => ({
  readCampaignSendSummary: (...args: unknown[]) => mockSummary(...args),
}))

import { GET, POST } from './route'

const context = { params: Promise.resolve({ id: 'camp-1' }) }
const summary = { run: 1, total: 10, sent: 6, failed: 1, pending: 2, processing: 0, skipped: 1, uncertain: 0, failureReason: 'Bad address', stallReason: null }
const progress = { total: 5, sent: 4, failed: 1, skipped: 0, uncertain: 0, remaining: 0, lost: 0 }

function post() {
  return POST(new NextRequest('https://crm.example.com/api/campaigns/camp-1/send', { method: 'POST' }), context)
}

describe('POST /api/campaigns/[id]/send', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })
    mockCredentials.mockResolvedValue({ apiKey: 'k', listId: 'l' })
    mockAdvance.mockResolvedValue({ kind: 'progress', status: 'sending', progress, summary })
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  it('refuses a caller without an approved session', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
    expect(mockAdvance).not.toHaveBeenCalled()
  })

  it('refuses when EmailOctopus is not configured', async () => {
    mockCredentials.mockResolvedValue(null)
    expect((await post()).status).toBe(409)
    expect(mockAdvance).not.toHaveBeenCalled()
  })

  it('advances one chunk with server-side credentials and the configured origin', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://crm.example.org'

    await post()

    expect(mockAdvance).toHaveBeenCalledWith(expect.anything(), 'camp-1', {
      credentials: { apiKey: 'k', listId: 'l' },
      baseUrl: 'https://crm.example.org',
      chunkSize: 200,
    })
  })

  it('reports cumulative totals, including skipped and uncertain, and what this chunk did', async () => {
    const body = await (await post()).json()

    expect(body).toMatchObject({
      status: 'sending',
      sent: 6,
      failed: 1,
      pending: 2,
      skipped: 1,
      uncertain: 0,
      hasMore: true,
      chunk: { processed: 5, sent: 4, failed: 1 },
      failureReason: 'Bad address',
    })
  })

  it.each([
    [{ kind: 'not_found' }, 404],
    [{ kind: 'conflict', message: 'changed after it was approved' }, 409],
  ])('maps %o to %s', async (outcome, status) => {
    mockAdvance.mockResolvedValue(outcome)
    expect((await post()).status).toBe(status)
  })

  it('stops the caller with a 500 when the ledger cannot be written', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockAdvance.mockRejectedValue(new LedgerWriteError('a sent outcome', 'connection reset'))

    const response = await post()

    expect(response.status).toBe(500)
    expect((await response.json()).error).toMatch(/send ledger/)
  })
})

describe('GET /api/campaigns/[id]/send', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'operator' })
  })

  it('returns the current run summary', async () => {
    mockSummary.mockResolvedValue(summary)
    const response = await GET(new NextRequest('https://crm.example.com/x'), context)

    expect(await response.json()).toEqual(summary)
  })

  it('answers 404 for an unknown campaign', async () => {
    mockSummary.mockRejectedValue(new Error('Campaign not found.'))
    expect((await GET(new NextRequest('https://crm.example.com/x'), context)).status).toBe(404)
  })
})

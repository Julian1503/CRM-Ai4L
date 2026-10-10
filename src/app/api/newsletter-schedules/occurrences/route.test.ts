/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()
const mockList = jest.fn()
const mockRetry = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockCreateServerClient() }))
jest.mock('@/lib/marketing/schedules/runDue', () => ({
  retryAndRunOccurrence: (...args: unknown[]) => mockRetry(...args),
}))
jest.mock('@/lib/marketing/schedules/occurrences', () => {
  const actual = jest.requireActual('@/lib/marketing/schedules/occurrences')
  return { ...actual, listAttentionOccurrences: (...args: unknown[]) => mockList(...args) }
})
jest.mock('@/lib/marketing/generateCampaign', () => ({
  getAnthropicApiKey: () => null,
  createAnthropicClient: () => ({ messages: { create: jest.fn() } }),
}))

import { OccurrenceRetryError } from '@/lib/marketing/schedules/occurrences'

import { POST as retry } from './[occurrenceId]/retry/route'
import { GET as list } from './route'

const OCCURRENCE_ID = '00000000-0000-4000-8000-0000000000c1'
const DB = { tag: 'member-db' }

function retryRequest(id = OCCURRENCE_ID) {
  return retry(
    new NextRequest(`https://crm.example.com/api/newsletter-schedules/occurrences/${id}/retry`, { method: 'POST' }),
    { params: Promise.resolve({ occurrenceId: id }) }
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSession.mockResolvedValue({ userId: 'u1', email: 'op@example.com', role: 'operator' })
  mockCreateServerClient.mockResolvedValue(DB)
})

describe('GET /api/newsletter-schedules/occurrences', () => {
  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await list()).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('lists the failed and skipped occurrences with the member’s client', async () => {
    mockList.mockResolvedValue([{ id: OCCURRENCE_ID, status: 'failed' }])
    const response = await list()
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual({ occurrences: [{ id: OCCURRENCE_ID, status: 'failed' }] })
    expect(mockList).toHaveBeenCalledWith(DB)
  })

  it('reports a read failure', async () => {
    mockList.mockRejectedValue(new Error('down'))
    expect((await list()).status).toBe(500)
  })
})

describe('POST /api/newsletter-schedules/occurrences/[occurrenceId]/retry', () => {
  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await retryRequest()).status).toBe(401)
    expect(mockRetry).not.toHaveBeenCalled()
  })

  it('404s a malformed id without touching the database', async () => {
    expect((await retryRequest('nope')).status).toBe(404)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('retries and drafts with the member’s own session, reporting the run', async () => {
    mockRetry.mockResolvedValue({ scheduleId: 's1', occurrenceId: OCCURRENCE_ID, status: 'in_review' })
    const response = await retryRequest()
    expect(response.status).toBe(200)
    expect((await response.json()).run).toMatchObject({ status: 'in_review' })
    expect(mockRetry.mock.calls[0][0]).toMatchObject({ db: DB, messages: null })
    expect(mockRetry.mock.calls[0][1]).toBe(OCCURRENCE_ID)
  })

  it.each([
    [new OccurrenceRetryError('Occurrence not found.', 404), 404],
    [new OccurrenceRetryError('Only a failed or skipped occurrence can be retried.', 409), 409],
    [new Error('boom'), 500],
  ])('maps %p to %s', async (error, status) => {
    mockRetry.mockRejectedValue(error)
    expect((await retryRequest()).status).toBe(status)
  })
})

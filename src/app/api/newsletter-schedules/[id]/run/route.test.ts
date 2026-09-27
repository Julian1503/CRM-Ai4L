/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()
const mockRunNow = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))
jest.mock('@/lib/marketing/schedules/runDue', () => ({
  runScheduleNow: (...args: unknown[]) => mockRunNow(...args),
}))
jest.mock('@/lib/marketing/generateCampaign', () => ({
  getAnthropicApiKey: () => 'sk-ant-test',
  createAnthropicClient: () => ({ messages: { create: jest.fn() } }),
}))

import { POST } from './route'

function run() {
  return POST(
    new NextRequest('https://crm.example.com/api/newsletter-schedules/s1/run', { method: 'POST' }),
    { params: Promise.resolve({ id: 's1' }) }
  )
}

describe('POST /api/newsletter-schedules/[id]/run', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    mockCreateServerClient.mockResolvedValue(
      createDbMock(createQueryBuilderMock({ data: { id: 's1', timezone: 'Australia/Sydney' }, error: null }))
    )
    mockRunNow.mockResolvedValue({ scheduleId: 's1', status: 'in_review', campaignId: 'c1' })
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await run()).status).toBe(401)
    expect(mockRunNow).not.toHaveBeenCalled()
  })

  it('drafts an issue and reports it', async () => {
    const response = await run()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      run: { scheduleId: 's1', status: 'in_review', campaignId: 'c1' },
    })
  })

  it('reports that today’s issue already exists', async () => {
    mockRunNow.mockResolvedValue({ scheduleId: 's1', status: 'skipped', reason: 'already_drafted' })

    expect((await run()).status).toBe(409)
  })

  it('explains an unusable template', async () => {
    mockRunNow.mockResolvedValue({ scheduleId: 's1', status: 'failed', reason: 'template_unusable' })

    const response = await run()

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/template/)
  })

  it('answers 404 for an unknown or archived schedule', async () => {
    mockCreateServerClient.mockResolvedValue(
      createDbMock(createQueryBuilderMock({ data: null, error: null }))
    )

    expect((await run()).status).toBe(404)
  })
})

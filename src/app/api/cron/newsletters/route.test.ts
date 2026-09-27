/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockRunDue = jest.fn()
const mockGetAdminClient = jest.fn()
const mockCreateClient = jest.fn()

jest.mock('@/lib/marketing/schedules/runDue', () => ({
  runDueSchedules: (...args: unknown[]) => mockRunDue(...args),
}))
jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockGetAdminClient() }))
jest.mock('@/lib/marketing/generateCampaign', () => ({
  getAnthropicApiKey: () => process.env.ANTHROPIC_API_KEY?.trim() || null,
  createAnthropicClient: (key: string) => mockCreateClient(key),
}))

import { GET } from './route'

function call(authorization?: string) {
  return GET(
    new NextRequest('https://crm.example.com/api/cron/newsletters', {
      headers: authorization ? { authorization } : {},
    })
  )
}

describe('GET /api/cron/newsletters', () => {
  const original = { secret: process.env.CRON_SECRET, key: process.env.ANTHROPIC_API_KEY }
  const db = { from: jest.fn() }
  const messages = { create: jest.fn() }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret-value'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    mockGetAdminClient.mockReturnValue(db)
    mockCreateClient.mockReturnValue({ messages })
    mockRunDue.mockResolvedValue([{ scheduleId: 'sched-1', status: 'in_review' }])
  })

  afterEach(() => {
    if (original.secret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = original.secret
    if (original.key === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = original.key
  })

  it('refuses a request without the secret', async () => {
    expect((await call()).status).toBe(401)
    expect(mockRunDue).not.toHaveBeenCalled()
  })

  it('refuses a wrong secret', async () => {
    expect((await call('Bearer not-the-secret')).status).toBe(401)
    expect(mockRunDue).not.toHaveBeenCalled()
  })

  it('refuses everything when CRON_SECRET is not configured', async () => {
    // Fail closed: an unset secret must not turn into "any bearer token works".
    delete process.env.CRON_SECRET

    expect((await call('Bearer ')).status).toBe(401)
    expect((await call('Bearer undefined')).status).toBe(401)
    expect(mockRunDue).not.toHaveBeenCalled()
  })

  it('runs due schedules with the service-role client and reports what happened', async () => {
    const response = await call('Bearer cron-secret-value')

    expect(response.status).toBe(200)
    expect(mockRunDue).toHaveBeenCalledWith({ db, messages, now: expect.any(Date) })
    await expect(response.json()).resolves.toEqual({
      runs: [{ scheduleId: 'sched-1', status: 'in_review' }],
    })
  })

  it('still drafts without an Anthropic key, so the gap is flagged rather than skipped', async () => {
    delete process.env.ANTHROPIC_API_KEY

    await call('Bearer cron-secret-value')

    expect(mockRunDue.mock.calls[0][0].messages).toBeNull()
  })

  it('reports a failure to read the schedules', async () => {
    mockRunDue.mockRejectedValue(new Error('database unreachable'))

    const response = await call('Bearer cron-secret-value')

    expect(response.status).toBe(500)
  })
})

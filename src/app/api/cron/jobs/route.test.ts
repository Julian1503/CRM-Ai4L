/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockRunJobs = jest.fn()

jest.mock('@/lib/jobs/runJobs', () => ({ runJobs: (...args: unknown[]) => mockRunJobs(...args) }))
jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({}) }))
jest.mock('@/lib/marketing/providers/credentials', () => ({
  loadEmailOctopusCredentials: async () => ({ apiKey: 'k', listId: 'l' }),
}))
jest.mock('@/lib/contacts/providerSync', () => ({ preferencesOrigin: () => 'https://crm.example.com' }))

import { GET } from './route'

const ORIGINAL = { ...process.env }

function get(authorization?: string) {
  return GET(
    new NextRequest('https://crm.example.com/api/cron/jobs', {
      headers: authorization ? { authorization } : {},
    })
  )
}

describe('GET /api/cron/jobs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...ORIGINAL, CRON_SECRET: 'cron-secret', NEXT_PUBLIC_APP_URL: 'https://crm.example.com' }
    mockRunJobs.mockResolvedValue({ consent: { claimed: 0 }, campaigns: [], stoppedForBudget: false })
  })

  afterAll(() => {
    process.env = ORIGINAL
  })

  it('refuses a call without the cron secret', async () => {
    expect((await get()).status).toBe(401)
    expect((await get('Bearer wrong')).status).toBe(401)
    expect(mockRunJobs).not.toHaveBeenCalled()
  })

  it('runs the jobs within a budget, with server-side credentials and origin', async () => {
    const response = await get('Bearer cron-secret')

    expect(response.status).toBe(200)
    expect(mockRunJobs).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { apiKey: 'k', listId: 'l' },
      baseUrl: 'https://crm.example.com',
      preferencesOrigin: 'https://crm.example.com',
      budgetMs: expect.any(Number),
    }))
  })

  it('answers 500 without leaking internals when a job fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockRunJobs.mockRejectedValue(new Error('relation secret_table does not exist'))

    const response = await get('Bearer cron-secret')

    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('secret_table')
  })
})

/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()
const mockVerify = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))
jest.mock('@/lib/marketing/providers/emailOctopus', () => ({
  verifyAutomation: (...args: unknown[]) => mockVerify(...args),
}))

import { POST } from './route'

function withCredentials(
  rows: { key: string; value: string }[] = [
    { key: 'emailoctopus_api_key', value: 'eo-key' },
    { key: 'emailoctopus_list_id', value: 'list-1' },
  ]
) {
  mockCreateServerClient.mockResolvedValue(
    createDbMock(createQueryBuilderMock({ data: rows, error: null }))
  )
}

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/integrations/emailoctopus/automations', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  )
}

describe('POST /api/integrations/emailoctopus/automations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    withCredentials()
    mockVerify.mockResolvedValue({ status: 'valid' })
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await post({ automationIds: ['a'] })).status).toBe(401)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('checks every id and keys the answers by id', async () => {
    mockVerify
      .mockResolvedValueOnce({ status: 'valid' })
      .mockResolvedValueOnce({ status: 'invalid', error: 'Journey not found.' })

    const body = await (await post({ automationIds: ['good', 'bad'] })).json()

    expect(body.results).toEqual({
      good: { status: 'valid' },
      bad: { status: 'invalid', error: 'Journey not found.' },
    })
  })

  it('never sends the API key to the client, only the verdict', async () => {
    const body = await (await post({ automationIds: ['good'] })).json()

    expect(JSON.stringify(body)).not.toContain('eo-key')
  })

  it('de-duplicates ids, since campaigns commonly share one automation', async () => {
    await post({ automationIds: ['a', 'a', ' a ', 'b'] })

    expect(mockVerify).toHaveBeenCalledTimes(2)
  })

  it('checks sequentially, because a burst would be rate-limited into "unknown"', async () => {
    let concurrent = 0
    let peak = 0
    mockVerify.mockImplementation(async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await Promise.resolve()
      concurrent -= 1
      return { status: 'valid' }
    })

    await post({ automationIds: ['a', 'b', 'c'] })

    expect(peak).toBe(1)
  })

  it('caps the batch so one page of campaigns cannot flood the provider', async () => {
    const response = await post({
      automationIds: Array.from({ length: 26 }, (_, index) => `auto-${index}`),
    })

    expect(response.status).toBe(400)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('rejects a body that is not a list of ids', async () => {
    expect((await post({ automationIds: 'auto-1' })).status).toBe(400)
    expect((await post({ automationIds: [] })).status).toBe(400)
    expect((await post({ automationIds: ['  ', ''] })).status).toBe(400)
  })

  it('says credentials are missing rather than reporting every id as invalid', async () => {
    // Without this the whole campaign list would show "not found" and send an operator
    // to fix ids that were correct.
    withCredentials([{ key: 'emailoctopus_api_key', value: 'eo-key' }])

    const response = await post({ automationIds: ['a'] })

    expect(response.status).toBe(409)
    expect(mockVerify).not.toHaveBeenCalled()
  })
})

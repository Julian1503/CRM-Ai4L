/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockGetSession = jest.fn()
const mockServerClient = jest.fn()
const mockRunAll = jest.fn()
const mockRunOne = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockServerClient() }))
jest.mock('@/lib/health/server', () => ({ healthDeps: (db: unknown) => ({ db }) }))
jest.mock('@/lib/health/runner', () => ({
  runAllHealthChecks: (...args: unknown[]) => mockRunAll(...args),
  runHealthCheck: (...args: unknown[]) => mockRunOne(...args),
}))

import { POST } from './[id]/test/route'
import { GET } from './route'

const CHECK = { id: 'stripe', label: 'Stripe', state: 'ok', summary: 'Ready.', checkedAt: '2026-10-12T00:00:00.000Z' }

function test(id: string) {
  return POST(new NextRequest(`https://crm.example.com/api/integrations/health/${id}/test`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })
}

describe('/api/integrations/health', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'a@example.com', role: 'admin' })
    mockServerClient.mockResolvedValue({ member: true })
    mockRunAll.mockResolvedValue([CHECK])
    mockRunOne.mockResolvedValue(CHECK)
  })

  it('requires a session for both routes', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
    expect((await test('stripe')).status).toBe(401)
    expect(mockRunAll).not.toHaveBeenCalled()
  })

  it('lists every check for a member, uncached, with the member client', async () => {
    mockGetSession.mockResolvedValue({ userId: 'u2', email: 'o@example.com', role: 'operator' })

    const response = await GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/)
    await expect(response.json()).resolves.toEqual({ checks: [CHECK] })
    expect(mockRunAll).toHaveBeenCalledWith({ db: { member: true } })
  })

  it('re-runs one check for an administrator only', async () => {
    const response = await test('stripe')
    await expect(response.json()).resolves.toEqual({ check: CHECK })
    expect(mockRunOne).toHaveBeenCalledWith('stripe', { db: { member: true } })

    mockGetSession.mockResolvedValue({ userId: 'u2', email: 'o@example.com', role: 'operator' })
    expect((await test('stripe')).status).toBe(403)
  })

  it('404s an unknown check id', async () => {
    expect((await test('passwords')).status).toBe(404)
    expect(mockRunOne).not.toHaveBeenCalled()
  })

  it('answers 500 with a fixed message on failure', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    mockRunAll.mockRejectedValue(new Error('secret detail'))
    mockRunOne.mockRejectedValue(new Error('secret detail'))

    const list = await GET()
    expect(list.status).toBe(500)
    await expect(list.json()).resolves.toEqual({ error: 'Could not check the integrations.' })
    const one = await test('stripe')
    expect(one.status).toBe(500)
    expect(JSON.stringify(await one.json())).not.toContain('secret')
  })
})

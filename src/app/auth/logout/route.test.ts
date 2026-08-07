/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockSignOut = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { POST } from './route'

const ORIGINAL_ENV = process.env
const ORIGIN = 'https://crm.example.com'

describe('POST /auth/logout', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = {
      ...ORIGINAL_ENV,
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    }
    mockCreateServerClient.mockResolvedValue({ auth: { signOut: mockSignOut } })
    mockSignOut.mockResolvedValue({ error: null })
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('clears the session server-side', async () => {
    await POST(new NextRequest(`${ORIGIN}/auth/logout`, { method: 'POST' }))

    expect(mockSignOut).toHaveBeenCalledTimes(1)
  })

  it('redirects to /login with 303 so the follow-up is a GET', async () => {
    const response = await POST(new NextRequest(`${ORIGIN}/auth/logout`, { method: 'POST' }))

    expect(response.status).toBe(303)
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login')
  })

  it('marks the response uncacheable', async () => {
    const response = await POST(new NextRequest(`${ORIGIN}/auth/logout`, { method: 'POST' }))

    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('still signs the user out locally when the auth service errors', async () => {
    mockSignOut.mockRejectedValue(new Error('auth service down'))

    const response = await POST(new NextRequest(`${ORIGIN}/auth/logout`, { method: 'POST' }))

    // Failing to log out is worse than a noisy error: the user asked to leave.
    expect(response.status).toBe(303)
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login')
  })

  it('does not crash when Supabase is unconfigured', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    const response = await POST(new NextRequest(`${ORIGIN}/auth/logout`, { method: 'POST' }))

    expect(response.status).toBe(303)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('redirects relative to the request origin, not a hardcoded host', async () => {
    const response = await POST(
      new NextRequest('https://other-host.example/auth/logout', { method: 'POST' })
    )

    expect(new URL(response.headers.get('location')!).origin).toBe('https://other-host.example')
  })
})

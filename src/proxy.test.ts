/**
 * @jest-environment node
 */
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest } from 'next/server'

type ServerClientOptions = {
  cookies: { getAll: () => unknown; setAll?: unknown }
}

const mockGetUser = jest.fn()
let mockMembership: MembershipRow = ACTIVE_OPERATOR
const mockCreateServerClient = jest.fn(
  (_url: string, _key: string, _options: ServerClientOptions) => ({
    auth: { getUser: mockGetUser },
    from: membershipFrom(mockMembership),
  })
)

jest.mock('@supabase/ssr', () => ({
  createServerClient: (url: string, key: string, options: ServerClientOptions) =>
    mockCreateServerClient(url, key, options),
}))

import { ACTIVE_OPERATOR, membershipFrom, type MembershipRow } from '@/test/membership'

import { config, proxy } from './proxy'

const ORIGINAL_ENV = process.env
const ORIGIN = 'https://crm.example.com'

function request(path: string) {
  return new NextRequest(`${ORIGIN}${path}`)
}

function authenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-1', email: 'admin@example.com' } },
    error: null,
  })
}

function anonymous() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
}

describe('proxy matcher', () => {
  // Note: the Next.js docs name this helper `unstable_doesProxyMatch`, but the
  // shipped build of 16.2.7 exports `unstable_doesMiddlewareMatch`.
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url })

  it.each(['/', '/contacts', '/settings', '/api/contacts/export'])(
    'runs the auth gate on %s',
    (url) => {
      expect(matches(url)).toBe(true)
    }
  )

  it.each([
    '/_next/static/chunks/main.js',
    '/_next/image?url=%2Flogo.png',
    '/favicon.ico',
    '/robots.txt',
  ])('skips %s so assets are not redirected to /login', (url) => {
    expect(matches(url)).toBe(false)
  })
})

describe('proxy', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = {
      ...ORIGINAL_ENV,
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    }
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('lets a signed-in user through', async () => {
    authenticated()

    const response = await proxy(request('/contacts'))

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
  })

  describe('approved membership (audit C1)', () => {
    afterEach(() => {
      mockMembership = ACTIVE_OPERATOR
    })

    it.each([
      ['no membership row', null],
      ['a disabled membership', { role: 'operator', active: false }],
    ])('redirects a verified user with %s to the login notice', async (_label, row) => {
      authenticated()
      mockMembership = row

      const response = await proxy(request('/contacts'))

      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toContain('reason=not-approved')
    })

    it('leaves API membership to the route DAL, which answers for itself', async () => {
      // Every route calls getSession(), which enforces membership (dal.test.ts); the
      // proxy does not spend a second lookup on API calls.
      authenticated()
      mockMembership = null

      const response = await proxy(request('/api/contacts'))

      expect(response.headers.get('location')).toBeNull()
    })
  })

  it('marks authenticated responses uncacheable so refreshed cookies are not shared', async () => {
    authenticated()

    const response = await proxy(request('/contacts'))

    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('cache-control')).toContain('private')
  })

  it('redirects an anonymous page request to /login', async () => {
    anonymous()

    const response = await proxy(request('/contacts'))

    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location')!)
    expect(location.pathname).toBe('/login')
  })

  it('preserves the requested page so login can return the user to it', async () => {
    anonymous()

    const response = await proxy(request('/contacts?state=NSW'))

    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('next')).toBe('/contacts?state=NSW')
  })

  it('answers an anonymous API request with 401 rather than a redirect', async () => {
    anonymous()

    const response = await proxy(request('/api/contacts/export'))

    expect(response.status).toBe(401)
    expect(response.headers.get('location')).toBeNull()
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
  })

  it('lets third-party webhooks through, since they carry no session', async () => {
    anonymous()

    const response = await proxy(request('/api/integrations/emailoctopus/webhook'))

    expect(response.status).toBe(200)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('lets the newsletter cron through, which authenticates with its own secret', async () => {
    anonymous()

    const response = await proxy(request('/api/cron/newsletters'))

    expect(response.status).toBe(200)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('lets the content worker protocol through, which authenticates by signature', async () => {
    anonymous()

    const response = await proxy(request('/api/internal/content-worker/v1/claim'))

    expect(response.status).toBe(200)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('keeps the user-facing content studio API behind the session gate', async () => {
    anonymous()

    const response = await proxy(request('/api/content-studio/items'))

    expect(response.status).toBe(401)
  })

  it('does not exempt the emailoctopus sync route, which acts for a user', async () => {
    anonymous()

    const response = await proxy(request('/api/integrations/emailoctopus/sync'))

    expect(response.status).toBe(401)
  })

  it('lets an anonymous user reach /login', async () => {
    anonymous()

    const response = await proxy(request('/login'))

    expect(response.status).toBe(200)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('lets the auth callback through so a session can be established', async () => {
    anonymous()

    const response = await proxy(request('/auth/callback?code=abc'))

    expect(response.status).toBe(200)
  })

  it('fails closed when Supabase is unconfigured, without building a client', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    const response = await proxy(request('/contacts'))

    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login')
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('denies rather than crashing when the auth lookup throws', async () => {
    mockGetUser.mockRejectedValue(new Error('auth server unreachable'))

    const response = await proxy(request('/contacts'))

    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login')
  })

  it('reads cookies from the request when constructing the auth client', async () => {
    authenticated()

    await proxy(request('/contacts'))

    const options = mockCreateServerClient.mock.calls[0][2]
    expect(typeof options.cookies.getAll).toBe('function')
    // setAll is required for token refresh to persist; omitting it causes
    // intermittent logouts that are very hard to diagnose.
    expect(typeof options.cookies.setAll).toBe('function')
  })
})

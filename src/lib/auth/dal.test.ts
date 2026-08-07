/**
 * @jest-environment node
 */
const mockGetUser = jest.fn()
const mockCreateServerClient = jest.fn()
const mockRedirect = jest.fn((_path: string): never => {
  // next/navigation's redirect throws to unwind the render; mirror that here so
  // tests prove callers cannot keep executing after an unauthenticated check.
  throw new Error('NEXT_REDIRECT')
})

jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

jest.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}))

const ORIGINAL_ENV = process.env

async function loadDal() {
  let mod: typeof import('./dal')
  await jest.isolateModulesAsync(async () => {
    mod = await import('./dal')
  })
  return mod!
}

describe('auth/dal', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = {
      ...ORIGINAL_ENV,
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    }
    mockCreateServerClient.mockResolvedValue({ auth: { getUser: mockGetUser } })
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  describe('getSession', () => {
    it('returns the user identity when Supabase confirms a valid session', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'user-1', email: 'admin@example.com' } },
        error: null,
      })

      const { getSession } = await loadDal()

      await expect(getSession()).resolves.toEqual({
        userId: 'user-1',
        email: 'admin@example.com',
      })
    })

    it('validates against the auth server rather than trusting the cookie', async () => {
      // getSession() decodes the cookie without verifying it and is spoofable;
      // getUser() revalidates. Asserting the call keeps that guarantee from
      // silently regressing.
      mockGetUser.mockResolvedValue({ data: { user: { id: 'u', email: 'e' } }, error: null })

      const { getSession } = await loadDal()
      await getSession()

      expect(mockGetUser).toHaveBeenCalledTimes(1)
    })

    it('returns null when there is no user', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

      const { getSession } = await loadDal()

      await expect(getSession()).resolves.toBeNull()
    })

    it('returns null when Supabase reports an error', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'invalid JWT' },
      })

      const { getSession } = await loadDal()

      await expect(getSession()).resolves.toBeNull()
    })

    it('fails closed when Supabase is not configured, without constructing a client', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

      const { getSession } = await loadDal()

      await expect(getSession()).resolves.toBeNull()
      expect(mockCreateServerClient).not.toHaveBeenCalled()
    })

    it('fails closed rather than throwing when the auth call rejects', async () => {
      mockGetUser.mockRejectedValue(new Error('network down'))

      const { getSession } = await loadDal()

      await expect(getSession()).resolves.toBeNull()
    })
  })

  describe('requireSession', () => {
    it('returns the session when authenticated', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'user-1', email: 'admin@example.com' } },
        error: null,
      })

      const { requireSession } = await loadDal()

      await expect(requireSession()).resolves.toEqual({
        userId: 'user-1',
        email: 'admin@example.com',
      })
      expect(mockRedirect).not.toHaveBeenCalled()
    })

    it('redirects to /login and halts execution when unauthenticated', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

      const { requireSession } = await loadDal()

      await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith('/login')
    })
  })
})

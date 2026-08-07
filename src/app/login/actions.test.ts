/**
 * @jest-environment node
 */
import { AUTH_FAILED_MESSAGE } from '@/lib/auth/credentials'

const mockSignInWithPassword = jest.fn()
const mockCreateServerClient = jest.fn()
const mockRedirect = jest.fn((_path: string): never => {
  // The real redirect() throws to unwind; mirroring that proves the action stops here.
  throw new Error('NEXT_REDIRECT')
})

jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

jest.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}))

import { INITIAL_LOGIN_STATE, login } from './actions'

const ORIGINAL_ENV = process.env

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  Object.entries(fields).forEach(([key, value]) => data.set(key, value))
  return data
}

describe('login action', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = {
      ...ORIGINAL_ENV,
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    }
    mockCreateServerClient.mockResolvedValue({
      auth: { signInWithPassword: mockSignInWithPassword },
    })
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('returns field errors without contacting Supabase', async () => {
    const result = await login(INITIAL_LOGIN_STATE, form({ email: '', password: '' }))

    expect(result.fieldErrors?.email).toEqual(expect.any(String))
    expect(result.fieldErrors?.password).toEqual(expect.any(String))
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('signs in with the normalised email', async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null })

    await expect(
      login(INITIAL_LOGIN_STATE, form({ email: '  Admin@Example.COM ', password: 'pw' }))
    ).rejects.toThrow('NEXT_REDIRECT')

    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'pw',
    })
  })

  it('redirects to the sanitised destination on success', async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null })

    await expect(
      login(INITIAL_LOGIN_STATE, form({ email: 'a@b.co', password: 'pw', next: '/contacts' }))
    ).rejects.toThrow('NEXT_REDIRECT')

    expect(mockRedirect).toHaveBeenCalledWith('/contacts')
  })

  it('refuses to redirect off-site after a successful sign-in', async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null })

    await expect(
      login(
        INITIAL_LOGIN_STATE,
        form({ email: 'a@b.co', password: 'pw', next: 'https://evil.example.com' })
      )
    ).rejects.toThrow('NEXT_REDIRECT')

    expect(mockRedirect).toHaveBeenCalledWith('/')
  })

  it('does not let the success redirect be swallowed as a network error', async () => {
    // redirect() throws; if it were inside the try/catch the user would see
    // "could not reach the authentication service" after a *successful* login.
    mockSignInWithPassword.mockResolvedValue({ error: null })

    await expect(
      login(INITIAL_LOGIN_STATE, form({ email: 'a@b.co', password: 'pw' }))
    ).rejects.toThrow('NEXT_REDIRECT')

    expect(mockRedirect).toHaveBeenCalledTimes(1)
  })

  it('returns one generic message for bad credentials', async () => {
    mockSignInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } })

    const result = await login(INITIAL_LOGIN_STATE, form({ email: 'a@b.co', password: 'wrong' }))

    expect(result.error).toBe(AUTH_FAILED_MESSAGE)
    expect(mockRedirect).not.toHaveBeenCalled()
  })

  it('does not leak whether an account exists', async () => {
    // Supabase distinguishes "email not confirmed" from "invalid credentials";
    // surfacing that difference would confirm which addresses have accounts.
    mockSignInWithPassword.mockResolvedValue({ error: { message: 'Email not confirmed' } })

    const result = await login(INITIAL_LOGIN_STATE, form({ email: 'a@b.co', password: 'pw' }))

    expect(result.error).toBe(AUTH_FAILED_MESSAGE)
    expect(result.error).not.toMatch(/confirm/i)
  })

  it('reports a configuration problem instead of failing silently', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    const result = await login(INITIAL_LOGIN_STATE, form({ email: 'a@b.co', password: 'pw' }))

    expect(result.error).toMatch(/not configured/i)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('surfaces a retryable message when the auth service is unreachable', async () => {
    mockSignInWithPassword.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await login(INITIAL_LOGIN_STATE, form({ email: 'a@b.co', password: 'pw' }))

    expect(result.error).toMatch(/try again/i)
    expect(result.error).not.toMatch(/ECONNREFUSED/)
  })
})

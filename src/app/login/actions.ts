'use server'

import { redirect } from 'next/navigation'

import { AUTH_FAILED_MESSAGE, validateLoginInput } from '@/lib/auth/credentials'
import { sanitizeNextPath } from '@/lib/auth/redirect'
import { isSupabaseConfigured } from '@/lib/supabase/config'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export type LoginState = {
  error: string | null
  fieldErrors?: { email?: string; password?: string }
}

export const INITIAL_LOGIN_STATE: LoginState = { error: null }

/**
 * Signs a user in with email and password.
 *
 * Invite-only: there is deliberately no sign-up path. Accounts are created from the
 * Supabase dashboard, so this action never creates users.
 *
 * On success it redirects rather than returning, so the browser performs a fresh
 * request that proxy.ts can attach the refreshed session cookie to.
 */
export async function login(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const validated = validateLoginInput(formData.get('email'), formData.get('password'))

  if (!validated.ok) {
    return { error: null, fieldErrors: validated.fieldErrors }
  }

  if (!isSupabaseConfigured()) {
    return {
      error:
        'Sign-in is unavailable because Supabase is not configured. Set ' +
        'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    }
  }

  let signInFailed = false

  try {
    const supabase = await createSupabaseServerClient()
    const { error } = await supabase.auth.signInWithPassword({
      email: validated.email,
      password: validated.password,
    })

    // Every failure reason collapses into one message. Supabase distinguishes
    // "invalid credentials" from "email not confirmed"; surfacing that difference
    // would confirm which addresses have accounts.
    signInFailed = Boolean(error)
  } catch {
    return { error: 'Could not reach the authentication service. Please try again.' }
  }

  if (signInFailed) {
    return { error: AUTH_FAILED_MESSAGE }
  }

  // redirect() throws to unwind, so it must sit outside the try/catch above -
  // otherwise the catch would swallow it and report a network error on success.
  redirect(sanitizeNextPath(formData.get('next') as string | null))
}

'use server'

import { redirect } from 'next/navigation'

import { AUTH_FAILED_MESSAGE, NOT_APPROVED_MESSAGE, validateLoginInput } from '@/lib/auth/credentials'
import { fetchActiveRole } from '@/lib/auth/membership'
import { sanitizeNextPath } from '@/lib/auth/redirect'
import { isSupabaseConfigured } from '@/lib/supabase/config'
import { createSupabaseServerClient } from '@/lib/supabase/server'

import type { LoginState } from './state'

// LoginState and INITIAL_LOGIN_STATE live in ./state because a 'use server' module may
// only export async functions; exporting a constant from here breaks the whole module
// at runtime.

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
  let notApproved = false

  try {
    const supabase = await createSupabaseServerClient()
    const { data, error } = await supabase.auth.signInWithPassword({
      email: validated.email,
      password: validated.password,
    })

    // Every failure reason collapses into one message. Supabase distinguishes
    // "invalid credentials" from "email not confirmed"; surfacing that difference
    // would confirm which addresses have accounts.
    signInFailed = Boolean(error) || !data?.user

    // A correct password is not CRM access (audit C1). The session is dropped at once
    // so an unapproved account holds no cookie at all.
    if (!signInFailed && data.user && !(await fetchActiveRole(supabase, data.user.id))) {
      notApproved = true
      await supabase.auth.signOut()
    }
  } catch {
    return { error: 'Could not reach the authentication service. Please try again.' }
  }

  if (signInFailed) {
    return { error: AUTH_FAILED_MESSAGE }
  }

  if (notApproved) {
    return { error: NOT_APPROVED_MESSAGE }
  }

  // redirect() throws to unwind, so it must sit outside the try/catch above -
  // otherwise the catch would swallow it and report a network error on success.
  redirect(sanitizeNextPath(formData.get('next') as string | null))
}

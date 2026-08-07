import 'server-only'

import { cache } from 'react'

import { redirect } from 'next/navigation'

import { isSupabaseConfigured } from '@/lib/supabase/config'
import { createSupabaseServerClient } from '@/lib/supabase/server'

/**
 * Data Access Layer for authentication.
 *
 * Every Server Component, Route Handler, and Server Action that touches CRM data must
 * call through here. proxy.ts performs an *optimistic* check only — the Next.js docs
 * warn that Server Functions are POSTs to their own route and can fall outside a proxy
 * matcher, so a matcher change can silently remove coverage. The authorisation check
 * has to live next to the data.
 *
 * Wrapped in React `cache()` so repeated calls within one render pass hit Supabase once.
 */

export type Session = {
  userId: string
  email: string
}

/**
 * Resolves the current session, or null.
 *
 * Uses `getUser()` rather than `getSession()` deliberately: `getSession()` decodes the
 * cookie without verifying it against the auth server, so a forged cookie would pass.
 * `getUser()` revalidates. The extra round trip is the price of the guarantee.
 *
 * Fails closed — any error, missing config, or absent user yields null.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  if (!isSupabaseConfigured()) {
    return null
  }

  try {
    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser()

    if (error || !user) {
      return null
    }

    return { userId: user.id, email: user.email ?? '' }
  } catch {
    // Network failure, malformed cookie, misconfiguration — all deny.
    return null
  }
})

/**
 * Session or redirect to /login.
 *
 * For Server Components and Server Actions. Route Handlers should call `getSession()`
 * and return a 401 instead, since a redirect is the wrong answer to a fetch.
 */
export const requireSession = cache(async (): Promise<Session> => {
  const session = await getSession()

  if (!session) {
    redirect('/login')
  }

  return session
})

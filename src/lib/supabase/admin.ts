import 'server-only'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * Service-role Supabase client. **Bypasses Row Level Security entirely.**
 *
 * Only for server contexts that have no user session and therefore cannot rely on
 * RLS — i.e. third-party webhooks (EmailOctopus, Stripe, Calendly). Anything acting
 * on behalf of a signed-in user must use `createSupabaseServerClient()` instead so
 * RLS stays in force.
 *
 * The `server-only` import above makes this a build error if it is ever reached from
 * a client component.
 *
 * Env is read at call time rather than module load so a missing key surfaces as a
 * handled runtime error on the one route that needs it, instead of breaking the build.
 */
export function getAdminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is not set. The service-role client cannot be created.'
    )
  }

  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. It is required for webhook handlers that ' +
        'write without a user session. Never expose it with a NEXT_PUBLIC_ prefix.'
    )
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

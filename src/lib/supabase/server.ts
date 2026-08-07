import 'server-only'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * Supabase client for Server Components, Route Handlers, and Server Actions.
 *
 * Uses the anon key plus the caller's session cookie, so Row Level Security applies —
 * this is the default for anything acting on behalf of a signed-in user.
 *
 * Note: `cookies()` is async in Next.js 16; synchronous access was removed. See
 * node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient<Database>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY before using CRM data features.'
    )
  }

  const cookieStore = await cookies()

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        } catch {
          // Server Components cannot set cookies. This is expected and safe: proxy.ts
          // refreshes the session cookie on every matched request, so the write here
          // is redundant rather than lost.
        }
      },
    },
  })
}

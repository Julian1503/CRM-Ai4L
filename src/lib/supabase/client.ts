import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

/** True when both public Supabase env vars are present. */
export const hasSupabaseConfig = Boolean(url && anonKey)

let browserClient: SupabaseClient<Database> | null = null

/**
 * Supabase client for Client Components.
 *
 * Uses the anon key and reads the session from cookies written by proxy.ts, so Row
 * Level Security governs every query. Safe to expose — the anon key is public by
 * design; RLS is what protects the data.
 *
 * Memoised because `createBrowserClient` sets up auth listeners; creating one per
 * render would leak them.
 */
export function createSupabaseBrowserClient(): SupabaseClient<Database> {
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY before using CRM data features.'
    )
  }

  if (!browserClient) {
    browserClient = createBrowserClient<Database>(url, anonKey)
  }

  return browserClient
}

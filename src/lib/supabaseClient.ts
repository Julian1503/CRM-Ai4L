/**
 * Legacy import path for the browser Supabase client.
 *
 * Re-exports the canonical client in ./supabase/client, which builds its client with
 * `createBrowserClient` from @supabase/ssr and so reads the session from the cookies
 * proxy.ts writes.
 *
 * This module used to call `createClient` from @supabase/supabase-js directly. That
 * client looks for a session in localStorage, but sign-in happens in a Server Action
 * that only ever writes cookies — so localStorage stayed empty and every browser query
 * ran as `anon`. Under RLS that fails asymmetrically and is easy to misread: SELECTs
 * return 200 with zero rows (the dashboard just looks empty) while writes fail with
 * 42501 "new row violates row-level security policy".
 */
export { createSupabaseBrowserClient as getSupabaseClient, hasSupabaseConfig } from './supabase/client'

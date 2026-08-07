/**
 * Shared accessor for the public Supabase connection settings.
 *
 * Read at call time rather than module load so tests can vary the environment and
 * so a missing value surfaces as a handled condition instead of a build failure.
 */
export type SupabaseConfig = {
  url: string
  anonKey: string
}

export function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

  if (!url || !anonKey) {
    return null
  }

  return { url, anonKey }
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfig() !== null
}

export const SUPABASE_NOT_CONFIGURED_MESSAGE =
  'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
  'NEXT_PUBLIC_SUPABASE_ANON_KEY before using CRM data features.'

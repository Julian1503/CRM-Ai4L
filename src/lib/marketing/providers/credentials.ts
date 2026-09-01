import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The EmailOctopus credentials, read from the `credentials` table.
 *
 * Server-side only, and never accepted from the client: the API key is the whole
 * mailing list. Shared by every route that talks to the provider, so the two key names
 * and the "both or nothing" rule are stated once instead of once per route.
 */
export type EmailOctopusCredentials = { apiKey: string; listId: string }

export async function loadEmailOctopusCredentials(
  // Typed loosely on purpose: the routes pass the request-scoped client and the tests
  // pass a mock, and pinning the generated Database type here would couple this helper
  // to a schema it never reads beyond two rows.
  db: Pick<SupabaseClient, 'from'>
): Promise<EmailOctopusCredentials | null> {
  const { data, error } = await db.from('credentials').select('key, value')

  if (error) throw new Error(error.message)

  const byKey = Object.fromEntries(
    (data ?? []).map((row: { key: string; value: string }) => [row.key, row.value])
  ) as Record<string, string>

  const apiKey = byKey.emailoctopus_api_key?.trim()
  const listId = byKey.emailoctopus_list_id?.trim()

  // A key with no list, or a list with no key, cannot do anything useful — treating it
  // as "not configured" gives the operator one message instead of a provider 401.
  return apiKey && listId ? { apiKey, listId } : null
}

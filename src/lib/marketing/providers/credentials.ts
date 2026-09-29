import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { getAdminClient } from '@/lib/supabase/admin'

/**
 * The EmailOctopus credentials, read from the `credentials` table.
 *
 * Server-side only, and never accepted from or returned to the client: the API key is
 * the whole mailing list. Since 20261002000000_crm_membership no browser role can read
 * the table at all (audit H1), so the default reader is the service role. Every caller
 * must already have checked the caller's membership.
 */
export type EmailOctopusCredentials = { apiKey: string; listId: string }

export const EMAILOCTOPUS_API_KEY = 'emailoctopus_api_key'
export const EMAILOCTOPUS_LIST_ID = 'emailoctopus_list_id'

type CredentialsDb = Pick<SupabaseClient, 'from'>

async function readRows(db: CredentialsDb): Promise<Record<string, string>> {
  const { data, error } = await db
    .from('credentials')
    .select('key, value')
    .in('key', [EMAILOCTOPUS_API_KEY, EMAILOCTOPUS_LIST_ID])

  if (error) throw new Error(error.message)

  return Object.fromEntries(
    (data ?? []).map((row: { key: string; value: string }) => [row.key, row.value])
  )
}

export async function loadEmailOctopusCredentials(
  db: CredentialsDb = getAdminClient()
): Promise<EmailOctopusCredentials | null> {
  const byKey = await readRows(db)

  const apiKey = byKey[EMAILOCTOPUS_API_KEY]?.trim()
  const listId = byKey[EMAILOCTOPUS_LIST_ID]?.trim()

  // A key with no list, or a list with no key, cannot do anything useful — treating it
  // as "not configured" gives the operator one message instead of a provider 401.
  return apiKey && listId ? { apiKey, listId } : null
}

/** What the settings screen may know: whether a key exists, never the key. */
export type EmailOctopusCredentialStatus = {
  apiKeyConfigured: boolean
  listId: string
  configured: boolean
}

export async function loadEmailOctopusStatus(
  db: CredentialsDb = getAdminClient()
): Promise<EmailOctopusCredentialStatus> {
  const byKey = await readRows(db)
  const apiKeyConfigured = Boolean(byKey[EMAILOCTOPUS_API_KEY]?.trim())
  const listId = byKey[EMAILOCTOPUS_LIST_ID]?.trim() ?? ''

  return { apiKeyConfigured, listId, configured: apiKeyConfigured && listId !== '' }
}

/**
 * A secret field in an update. The browser never holds the saved value, so an empty
 * input cannot mean "clear" — it means "leave it". Clearing is its own explicit action.
 */
export type SecretChange =
  | { action: 'unchanged' }
  | { action: 'replace'; value: string }
  | { action: 'clear' }

export type EmailOctopusUpdate = { apiKey: SecretChange; listId: string }

const MAX_CREDENTIAL_LENGTH = 512

export function parseEmailOctopusUpdate(
  body: Record<string, unknown>
): { ok: true; update: EmailOctopusUpdate } | { ok: false; error: string } {
  const rawKey = body.apiKey as { action?: unknown; value?: unknown } | undefined
  const action = rawKey?.action ?? 'unchanged'
  let apiKey: SecretChange

  if (action === 'unchanged' || action === 'clear') {
    apiKey = { action }
  } else if (action === 'replace') {
    const value = typeof rawKey?.value === 'string' ? rawKey.value.trim() : ''
    if (!value) return { ok: false, error: 'Enter the new API key, or leave the key unchanged.' }
    if (value.length > MAX_CREDENTIAL_LENGTH) return { ok: false, error: 'The API key is too long.' }
    apiKey = { action: 'replace', value }
  } else {
    return { ok: false, error: 'apiKey.action must be unchanged, replace or clear.' }
  }

  if (typeof body.listId !== 'string') return { ok: false, error: 'listId is required.' }
  const listId = body.listId.trim()
  if (listId.length > MAX_CREDENTIAL_LENGTH) return { ok: false, error: 'The list ID is too long.' }

  return { ok: true, update: { apiKey, listId } }
}

export async function saveEmailOctopusUpdate(
  update: EmailOctopusUpdate,
  db: CredentialsDb = getAdminClient()
): Promise<void> {
  // Clearing blanks the value rather than deleting the row: nothing here physically
  // deletes, and a blank value already reads as "not configured".
  const writes: Array<{ key: string; value: string }> = [
    { key: EMAILOCTOPUS_LIST_ID, value: update.listId },
  ]

  if (update.apiKey.action === 'replace') {
    writes.push({ key: EMAILOCTOPUS_API_KEY, value: update.apiKey.value })
  } else if (update.apiKey.action === 'clear') {
    writes.push({ key: EMAILOCTOPUS_API_KEY, value: '' })
  }

  const { error } = await db.from('credentials').upsert(writes, { onConflict: 'key' })
  if (error) throw new Error(error.message)
}

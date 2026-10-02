import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUuid } from '@/lib/contacts/tags'
import { decryptSecret, encryptSecret, envelopeKeyVersion } from '@/lib/crypto/secretBox'
import type { Database } from '@/lib/db/types'
import { getAdminClient } from '@/lib/supabase/admin'

/**
 * Encrypted social tokens (social_account_secrets).
 *
 * The table is invisible to every browser role, so this module always uses the service
 * role. Every caller must already have authorised the action: an administrator
 * connecting an account, or the worker bridge building the context of a publish_social
 * job it holds the lease for. Tokens are encrypted with secretBox and bound (AAD) to
 * their account and field, so a value copied into another row cannot be decrypted.
 *
 * Nothing here logs, returns in an error, or stores a token in plaintext.
 */

const MAX_TOKEN_LENGTH = 8192

export type SocialTokens = {
  accessToken: string
  refreshToken?: string | null
  /** ISO timestamp when the access token expires, if the provider says. */
  expiresAt?: string | null
}

type Db = SupabaseClient<Database>

export function tokenAad(accountId: string, field: 'access_token' | 'refresh_token'): string {
  return `social_account:${accountId}:${field}`
}

function assertToken(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TOKEN_LENGTH) {
    throw new TypeError(`${name} must be a non-empty string of at most ${MAX_TOKEN_LENGTH} characters.`)
  }
}

function assertAccountId(accountId: string): void {
  if (!isUuid(accountId)) throw new TypeError('accountId must be a UUID.')
}

/** Encrypts and stores (insert or replace) an account's tokens. */
export async function saveAccountSecrets(accountId: string, tokens: SocialTokens, db: Db = getAdminClient()): Promise<void> {
  assertAccountId(accountId)
  assertToken(tokens.accessToken, 'accessToken')
  if (tokens.refreshToken != null) assertToken(tokens.refreshToken, 'refreshToken')

  const accessToken = encryptSecret(tokens.accessToken, tokenAad(accountId, 'access_token'))
  const refreshToken =
    tokens.refreshToken == null ? null : encryptSecret(tokens.refreshToken, tokenAad(accountId, 'refresh_token'))

  const { error } = await db.from('social_account_secrets').upsert(
    {
      account_id: accountId,
      access_token: accessToken,
      refresh_token: refreshToken,
      key_version: envelopeKeyVersion(accessToken) ?? 0,
      expires_at: tokens.expiresAt ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'account_id' }
  )
  if (error) throw new Error(`Could not store the account credentials: ${error.message}`)
}

type SecretRow = { access_token: string; refresh_token: string | null; expires_at: string | null }

async function readSecretRow(accountId: string, db: Db): Promise<SecretRow | null> {
  assertAccountId(accountId)
  const { data, error } = await db
    .from('social_account_secrets')
    .select('access_token, refresh_token, expires_at')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`Could not read the account credentials: ${error.message}`)
  return (data as SecretRow | null) ?? null
}

/** The decrypted access token, or null when the account has no stored credentials. */
export async function loadAccessToken(accountId: string, db: Db = getAdminClient()): Promise<string | null> {
  const row = await readSecretRow(accountId, db)
  return row ? decryptSecret(row.access_token, tokenAad(accountId, 'access_token')) : null
}

/** Every stored token, decrypted — for a refresh flow. Null when none are stored. */
export async function loadAccountTokens(accountId: string, db: Db = getAdminClient()): Promise<SocialTokens | null> {
  const row = await readSecretRow(accountId, db)
  if (!row) return null

  return {
    accessToken: decryptSecret(row.access_token, tokenAad(accountId, 'access_token')),
    refreshToken: row.refresh_token ? decryptSecret(row.refresh_token, tokenAad(accountId, 'refresh_token')) : null,
    expiresAt: row.expires_at,
  }
}

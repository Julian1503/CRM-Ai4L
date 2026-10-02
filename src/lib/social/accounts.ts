import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { ContentHttpError, throwIfDbError } from '@/lib/content-studio/errors'
import { toSocialAccount } from '@/lib/content-studio/mappers'
import type { SocialAccount, SocialProvider } from '@/lib/content-studio/types'
import type { Database, SocialAccountRow } from '@/lib/db/types'

import { saveAccountSecrets } from './credentials'
import type { EngineAccount } from './engineClient'

/**
 * Social account catalogue.
 *
 * Members read accounts through their own client (RLS). Writes — connecting after an
 * OAuth exchange and disconnecting — use the service role, after the route has checked
 * that the caller is an administrator. An account is never deleted: disconnecting sets
 * its status, so publications keep a valid reference and the history stays readable.
 */

type Db = SupabaseClient<Database>

const MAX_ACCOUNTS = 200

export async function listSocialAccounts(db: Db): Promise<SocialAccount[]> {
  const { data, error } = await db
    .from('social_accounts')
    .select('*')
    .order('platform', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(MAX_ACCOUNTS)
  throwIfDbError(error)
  return ((data ?? []) as SocialAccountRow[]).map(toSocialAccount)
}

async function audit(admin: Db, actorId: string, action: string, accountId: string, details: Record<string, unknown>) {
  const { error } = await admin.from('content_audit_events').insert({
    actor_id: actorId,
    action,
    subject_type: 'social_account',
    subject_id: accountId,
    details,
  })
  if (error) console.error(`Social audit event ${action} was not recorded:`, error.message)
}

/**
 * Makes the stored credentials unusable without deleting the row (no physical deletes):
 * the access token becomes an empty string, which is not a secretBox envelope and cannot
 * be decrypted, and the refresh token is cleared. loadAccountTokens then fails, so
 * preflight reports token_unreadable and no worker context can carry a token. A later
 * reconnect upserts fresh encrypted tokens over this row.
 *
 * Provider-side revocation (Meta/LinkedIn token revoke endpoints) is out of scope: the
 * token stays valid at the provider until it expires or the admin removes the app there.
 */
async function wipeAccountSecrets(admin: Db, accountId: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await admin
    .from('social_account_secrets')
    .update({ access_token: '', refresh_token: null, expires_at: now, updated_at: now })
    .eq('account_id', accountId)
  throwIfDbError(error)
}

/** Disconnects (status 'disconnected', never deleted) and wipes the stored tokens. Idempotent. */
export async function disconnectSocialAccount(admin: Db, accountId: string, actorId: string): Promise<SocialAccount> {
  const { data, error } = await admin
    .from('social_accounts')
    .update({ status: 'disconnected', updated_at: new Date().toISOString() })
    .eq('id', accountId)
    .select('*')
    .maybeSingle()
  throwIfDbError(error)
  if (!data) throw new ContentHttpError(404, 'Account not found.')

  await wipeAccountSecrets(admin, accountId)
  await audit(admin, actorId, 'social_account.disconnected', accountId, { platform: data.platform })
  return toSocialAccount(data as SocialAccountRow)
}

/** Mock destinations live in their own namespace so they can never overwrite a real row. */
export function storedExternalId(provider: SocialProvider, externalId: string): string {
  return provider === 'mock' && !externalId.startsWith('mock:') ? `mock:${externalId}` : externalId
}

type ConnectInput = { provider: SocialProvider; brandId: string; actorId: string }

/**
 * The account row for a destination, without touching its status: an existing row keeps
 * whatever it was (connected, needs_reauth, disconnected) and a new one starts as
 * needs_reauth, until its credentials are safely stored.
 */
async function ensureAccountRow(admin: Db, account: EngineAccount, input: ConnectInput): Promise<string> {
  const externalId = storedExternalId(input.provider, account.externalId)
  const details = {
    brand_id: input.brandId,
    provider: input.provider,
    display_name: account.displayName,
    author_kind: account.authorKind,
    scopes: account.scopes,
    connected_by: input.actorId,
    updated_at: new Date().toISOString(),
  }
  const { data: existing, error: readError } = await admin
    .from('social_accounts')
    .select('id')
    .eq('platform', account.platform)
    .eq('external_id', externalId)
    .maybeSingle()
  throwIfDbError(readError)

  const { data, error } = existing
    ? await admin.from('social_accounts').update(details).eq('id', (existing as { id: string }).id).select('id').single()
    : await admin
        .from('social_accounts')
        .insert({ ...details, platform: account.platform, external_id: externalId, status: 'needs_reauth' })
        .select('id')
        .single()
  throwIfDbError(error)
  return (data as { id: string }).id
}

/**
 * Stores what an OAuth exchange discovered. Order matters: the row exists first (the
 * token encryption is bound to its id), then the encrypted tokens are written, and only
 * then is the account marked connected — a failed secret write never flips an account to
 * connected. Returns the ids saved.
 */
export async function saveConnectedAccounts(
  admin: Db,
  input: ConnectInput & { accounts: EngineAccount[] }
): Promise<string[]> {
  const saved: string[] = []
  for (const account of input.accounts) {
    const id = await ensureAccountRow(admin, account, input)
    await saveAccountSecrets(
      id,
      { accessToken: account.accessToken, refreshToken: account.refreshToken, expiresAt: account.expiresAt },
      admin
    )
    const { error } = await admin
      .from('social_accounts')
      .update({ status: 'connected', last_error: null, updated_at: new Date().toISOString() })
      .eq('id', id)
    throwIfDbError(error)

    await audit(admin, input.actorId, 'social_account.connected', id, {
      platform: account.platform,
      provider: input.provider,
      authorKind: account.authorKind,
    })
    saved.push(id)
  }
  return saved
}

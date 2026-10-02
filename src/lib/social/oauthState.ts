import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import { throwIfDbError } from '@/lib/content-studio/errors'
import type { SocialProvider } from '@/lib/content-studio/types'
import type { Database } from '@/lib/db/types'

/**
 * Single-use OAuth state (social_oauth_states, service role only).
 *
 * The browser only ever sees the random state; the table stores its SHA-256. Consuming
 * it is one conditional UPDATE — not yet consumed, not expired, same provider, same
 * administrator — so a replayed, expired or foreign callback matches no row. Options
 * (e.g. the LinkedIn author mode) never hold a secret.
 */

type Db = SupabaseClient<Database>
type Env = Record<string, string | undefined>

export const STATE_TTL_MS = 10 * 60 * 1000
export const OAUTH_PROVIDERS: readonly SocialProvider[] = ['meta', 'linkedin', 'mock']

export type OAuthOptions = Record<string, string>

export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex')
}

/** 'mock' connects fake accounts; allowed only outside production or when opted in. */
export function isProviderAllowed(provider: string, env: Env = process.env): provider is SocialProvider {
  if (provider === 'meta' || provider === 'linkedin') return true
  if (provider !== 'mock') return false
  return env.NODE_ENV !== 'production' || env.CONTENT_SOCIAL_ALLOW_MOCK?.trim().toLowerCase() === 'true'
}

/** Only known, non-secret options survive; LinkedIn defaults to posting as an organization. */
export function parseOAuthOptions(provider: SocialProvider, raw: Record<string, unknown>): OAuthOptions | null {
  if (provider === 'meta') return {}
  const kind = raw.authorKind ?? raw.authorMode ?? 'organization'
  if (kind !== 'organization' && kind !== 'member') return null
  return { authorKind: kind }
}

export async function createOAuthState(
  admin: Db,
  input: { provider: SocialProvider; actorId: string; brandId: string; options: OAuthOptions },
  now: Date = new Date()
): Promise<string> {
  const state = randomBytes(32).toString('base64url')
  const { error } = await admin.from('social_oauth_states').insert({
    state_hash: hashState(state),
    provider: input.provider,
    actor_id: input.actorId,
    brand_id: input.brandId,
    options: input.options,
    expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  })
  throwIfDbError(error)
  return state
}

export type ConsumedState = { brandId: string; options: OAuthOptions }

/** Marks the state used and returns it, or null when it is unknown, used, expired or someone else's. */
export async function consumeOAuthState(
  admin: Db,
  input: { state: string; provider: SocialProvider; actorId: string },
  now: Date = new Date()
): Promise<ConsumedState | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.state)) return null
  const { data, error } = await admin
    .from('social_oauth_states')
    .update({ consumed_at: now.toISOString() })
    .eq('state_hash', hashState(input.state))
    .eq('provider', input.provider)
    .eq('actor_id', input.actorId)
    .is('consumed_at', null)
    .gt('expires_at', now.toISOString())
    .select('brand_id, options')
    .maybeSingle()
  throwIfDbError(error)
  if (!data) return null

  const options = typeof data.options === 'object' && data.options !== null && !Array.isArray(data.options)
    ? Object.fromEntries(Object.entries(data.options).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  return { brandId: data.brand_id, options }
}

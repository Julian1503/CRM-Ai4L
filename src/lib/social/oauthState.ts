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
 * administrator — so a replayed, expired or foreign callback matches no row.
 */

type Db = SupabaseClient<Database>
type Env = Record<string, string | undefined>

export const STATE_TTL_MS = 10 * 60 * 1000
export const OAUTH_PROVIDERS: readonly SocialProvider[] = ['meta', 'mock']

export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex')
}

/** 'mock' connects fake accounts; allowed only outside production or when opted in. */
export function isProviderAllowed(provider: string, env: Env = process.env): provider is SocialProvider {
  if (provider === 'meta') return true
  if (provider !== 'mock') return false
  return env.NODE_ENV !== 'production' || env.CONTENT_SOCIAL_ALLOW_MOCK?.trim().toLowerCase() === 'true'
}

export async function createOAuthState(
  admin: Db,
  input: { provider: SocialProvider; actorId: string; brandId: string },
  now: Date = new Date()
): Promise<string> {
  const state = randomBytes(32).toString('base64url')
  const { error } = await admin.from('social_oauth_states').insert({
    state_hash: hashState(state),
    provider: input.provider,
    actor_id: input.actorId,
    brand_id: input.brandId,
    expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  })
  throwIfDbError(error)
  return state
}

export type ConsumedState = { brandId: string }

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
    .select('brand_id')
    .maybeSingle()
  throwIfDbError(error)
  return data ? { brandId: data.brand_id } : null
}

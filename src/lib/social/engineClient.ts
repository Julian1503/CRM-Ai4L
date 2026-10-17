import 'server-only'

import type { SocialAuthorKind, SocialPlatform, SocialProvider } from '@/lib/content-studio/types'
import { EngineError, postToEngine, type Env } from '@/lib/content-studio/engineHttp'

import type { OAuthOptions } from './oauthState'

/**
 * Server-to-server client for the content engine's OAuth endpoints
 * (services/content-engine/app/main.py), signed with CONTENT_ENGINE_SECRET by
 * src/lib/content-studio/engineHttp.ts.
 *
 * The engine holds the Meta/LinkedIn app secrets; the CRM only sends the state, the
 * redirect URI and the code. Tokens come back in the exchange response, go straight to
 * credentials.ts for encryption, and never appear in an error message or a log line.
 */

export { EngineError, type EngineErrorCode } from '@/lib/content-studio/engineHttp'

const MAX_ACCOUNTS = 50

export type EngineAccount = {
  platform: SocialPlatform
  externalId: string
  displayName: string
  authorKind: SocialAuthorKind
  scopes: string[]
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
}

export async function requestAuthorizeUrl(
  provider: SocialProvider,
  input: { state: string; redirectUri: string; options: OAuthOptions },
  env: Env = process.env
): Promise<string> {
  const data = await postToEngine(`/v1/oauth/${provider}/authorize-url`, input, env)
  if (typeof data.url !== 'string' || !/^https?:\/\//.test(data.url)) throw new EngineError('engine_invalid_response')
  return data.url
}

const AUTHOR_KINDS: Readonly<Record<SocialPlatform, readonly SocialAuthorKind[]>> = {
  facebook: ['page'],
  instagram: ['instagram_business'],
  linkedin: ['organization', 'member'],
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : null
}

/** One account from the engine, or null when it does not fit the contract. */
export function parseEngineAccount(value: unknown): EngineAccount | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const platform = row.platform as SocialPlatform
  const kinds = AUTHOR_KINDS[platform]
  const externalId = boundedString(row.externalId, 200)
  const displayName = boundedString(row.displayName, 200)
  const accessToken = typeof row.accessToken === 'string' && row.accessToken !== '' ? row.accessToken : null
  if (!kinds || !kinds.includes(row.authorKind as SocialAuthorKind) || !externalId || !displayName || !accessToken) {
    return null
  }
  const expiresAt = optionalString(row.expiresAt)
  return {
    platform,
    externalId,
    displayName,
    authorKind: row.authorKind as SocialAuthorKind,
    scopes: Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === 'string').slice(0, 50) : [],
    accessToken,
    refreshToken: optionalString(row.refreshToken),
    expiresAt: expiresAt && !Number.isNaN(Date.parse(expiresAt)) ? expiresAt : null,
  }
}

export async function exchangeCode(
  provider: SocialProvider,
  input: { code: string; redirectUri: string; options: OAuthOptions },
  env: Env = process.env
): Promise<EngineAccount[]> {
  const data = await postToEngine(`/v1/oauth/${provider}/exchange`, input, env)
  if (!Array.isArray(data.accounts)) throw new EngineError('engine_invalid_response')
  return data.accounts
    .slice(0, MAX_ACCOUNTS)
    .map(parseEngineAccount)
    .filter((account): account is EngineAccount => account !== null)
}

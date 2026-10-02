import 'server-only'

import type { SocialAuthorKind, SocialPlatform, SocialProvider } from '@/lib/content-studio/types'
import {
  MIN_WORKER_SECRET_LENGTH,
  signWorkerRequest,
  WORKER_SIGNATURE_HEADER,
  WORKER_TIMESTAMP_HEADER,
} from '@/lib/content-studio/workerAuth'

import type { OAuthOptions } from './oauthState'

/**
 * Server-to-server client for the content engine's OAuth endpoints
 * (services/content-engine/app/main.py). Requests are signed exactly like the worker
 * protocol (HMAC-SHA256 over `${ts}.POST.${path}.${body}`), but with its own secret,
 * CONTENT_ENGINE_SECRET: CRM → engine is a different direction from the worker's
 * engine → CRM (CONTENT_WORKER_SECRET), so one leaked key cannot drive both.
 *
 * The engine holds the Meta/LinkedIn app secrets; the CRM only sends the state, the
 * redirect URI and the code. Tokens come back in the exchange response, go straight to
 * credentials.ts for encryption, and never appear in an error message or a log line.
 */

const TIMEOUT_MS = 15_000
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

/** Machine code only: safe to show in a redirect or log. */
export type EngineErrorCode = 'engine_not_configured' | 'engine_unreachable' | 'engine_refused' | 'engine_invalid_response'

export class EngineError extends Error {
  readonly code: EngineErrorCode
  readonly status: number | null

  constructor(code: EngineErrorCode, status: number | null = null) {
    super(`Content engine error: ${code}${status ? ` (HTTP ${status})` : ''}`)
    this.name = 'EngineError'
    this.code = code
    this.status = status
  }
}

type Env = Record<string, string | undefined>

function engineSecret(env: Env): string | null {
  const secret = env.CONTENT_ENGINE_SECRET?.trim()
  return secret && secret.length >= MIN_WORKER_SECRET_LENGTH ? secret : null
}

function engineBase(env: Env): URL {
  const raw = env.CONTENT_ENGINE_URL?.trim()
  if (!raw) throw new EngineError('engine_not_configured')
  try {
    return new URL(raw.endsWith('/') ? raw : `${raw}/`)
  } catch {
    throw new EngineError('engine_not_configured')
  }
}

async function post(path: string, payload: unknown, env: Env): Promise<Record<string, unknown>> {
  const secret = engineSecret(env)
  if (!secret) throw new EngineError('engine_not_configured')

  const url = new URL(path.replace(/^\//, ''), engineBase(env))
  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [WORKER_TIMESTAMP_HEADER]: String(timestamp),
        [WORKER_SIGNATURE_HEADER]: signWorkerRequest(secret, timestamp, 'POST', url.pathname, body),
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new EngineError('engine_unreachable')
  }

  if (!response.ok) throw new EngineError(response.status >= 500 ? 'engine_unreachable' : 'engine_refused', response.status)
  const data: unknown = await response.json().catch(() => null)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new EngineError('engine_invalid_response')
  return data as Record<string, unknown>
}

export async function requestAuthorizeUrl(
  provider: SocialProvider,
  input: { state: string; redirectUri: string; options: OAuthOptions },
  env: Env = process.env
): Promise<string> {
  const data = await post(`/v1/oauth/${provider}/authorize-url`, input, env)
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
  const data = await post(`/v1/oauth/${provider}/exchange`, input, env)
  if (!Array.isArray(data.accounts)) throw new EngineError('engine_invalid_response')
  return data.accounts
    .slice(0, MAX_ACCOUNTS)
    .map(parseEngineAccount)
    .filter((account): account is EngineAccount => account !== null)
}

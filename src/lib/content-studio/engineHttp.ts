import 'server-only'

import {
  MIN_WORKER_SECRET_LENGTH,
  signWorkerRequest,
  WORKER_SIGNATURE_HEADER,
  WORKER_TIMESTAMP_HEADER,
} from './workerAuth'

/**
 * Signed CRM → engine requests (services/content-engine/app/main.py), shared by the
 * OAuth client (src/lib/social/engineClient.ts) and suggestions (./suggestions.ts).
 *
 * Requests are signed exactly like the worker protocol (HMAC-SHA256 over
 * `${ts}.POST.${path}.${body}`), but with their own secret, CONTENT_ENGINE_SECRET:
 * CRM → engine is a different direction from the worker's engine → CRM
 * (CONTENT_WORKER_SECRET), so one leaked key cannot drive both.
 */

const DEFAULT_TIMEOUT_MS = 15_000

/** Machine code only: safe to show in a redirect or log. */
export type EngineErrorCode = 'engine_not_configured' | 'engine_unreachable' | 'engine_refused' | 'engine_invalid_response'

export class EngineError extends Error {
  readonly code: EngineErrorCode
  readonly status: number | null
  /** The engine's own machine code from an error body (`{ error, code }`), when it sent one. */
  readonly engineCode: string | null

  constructor(code: EngineErrorCode, status: number | null = null, engineCode: string | null = null) {
    super(`Content engine error: ${code}${status ? ` (HTTP ${status})` : ''}`)
    this.name = 'EngineError'
    this.code = code
    this.status = status
    this.engineCode = engineCode
  }
}

export type Env = Record<string, string | undefined>

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

function readEngineCode(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const code = (data as Record<string, unknown>).code
  return typeof code === 'string' && /^[a-z][a-z0-9_]{1,60}$/.test(code) ? code : null
}

/** Whether a URL and a valid secret are set, checked before anything is spent on a call. */
export function isEngineConfigured(env: Env): boolean {
  if (!engineSecret(env)) return false
  try {
    engineBase(env)
    return true
  } catch {
    return false
  }
}

export async function postToEngine(
  path: string,
  payload: unknown,
  env: Env,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Record<string, unknown>> {
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
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new EngineError('engine_unreachable')
  }

  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new EngineError(response.status >= 500 ? 'engine_unreachable' : 'engine_refused', response.status, readEngineCode(data))
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new EngineError('engine_invalid_response')
  return data as Record<string, unknown>
}

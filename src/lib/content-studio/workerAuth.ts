import 'server-only'

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Authentication for the content-engine worker protocol (docs/CONTENT_STUDIO_CONTRACTS.md §3).
 *
 * The worker endpoints sit outside the session gate (INTERNAL_WORKER_PATHS), so this
 * signature is their only authentication. It binds the timestamp, the method, the exact
 * path and the exact body, so a captured request cannot be replayed after 5 minutes nor
 * re-aimed at another operation. Within the window a replay is harmless: every mutation
 * also needs the job's current claim token, which the SQL functions check.
 *
 * CONTENT_WORKER_SECRET is separate from CRON_SECRET and the service role key, so it can
 * be rotated alone and a leak of one does not open the others.
 */

export const WORKER_TIMESTAMP_HEADER = 'x-content-worker-timestamp'
export const WORKER_SIGNATURE_HEADER = 'x-content-worker-signature'
export const WORKER_TOLERANCE_SECONDS = 300
/** A shorter secret is refused rather than trusted (same floor as readiness strongSecret). */
export const MIN_WORKER_SECRET_LENGTH = 32
/**
 * The largest body read before the signature is checked. Worker payloads are small (the
 * biggest is a generation result); without a cap an unauthenticated client could make the
 * route buffer an arbitrarily large body.
 */
export const MAX_WORKER_BODY_BYTES = 512 * 1024

export type WorkerAuthFailure =
  | 'secret_not_configured'
  | 'missing_signature'
  | 'malformed_signature'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch'
  | 'body_too_large'

export type WorkerAuthResult = { ok: true } | { ok: false; reason: WorkerAuthFailure }

export function getWorkerSecret(): string | null {
  const secret = process.env.CONTENT_WORKER_SECRET?.trim()

  return secret && secret.length >= MIN_WORKER_SECRET_LENGTH ? secret : null
}

export function signWorkerRequest(
  secret: string,
  timestamp: number,
  method: string,
  path: string,
  body: string,
): string {
  const payload = `${timestamp}.${method.toUpperCase()}.${path}.${body}`

  return `v1=${createHmac('sha256', secret).update(payload, 'utf8').digest('hex')}`
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export interface VerifyWorkerRequestInput {
  method: string
  path: string
  rawBody: string
  timestampHeader: string | null
  signatureHeader: string | null
  nowSeconds?: number
  secret?: string | null
}

export function verifyWorkerRequest(input: VerifyWorkerRequestInput): WorkerAuthResult {
  const secret = input.secret === undefined ? getWorkerSecret() : input.secret

  if (!secret) return { ok: false, reason: 'secret_not_configured' }
  if (!input.timestampHeader || !input.signatureHeader) return { ok: false, reason: 'missing_signature' }
  if (!/^\d{1,12}$/.test(input.timestampHeader.trim())) return { ok: false, reason: 'malformed_signature' }
  if (!/^v1=[0-9a-f]{64}$/.test(input.signatureHeader.trim())) return { ok: false, reason: 'malformed_signature' }

  const timestamp = Number.parseInt(input.timestampHeader.trim(), 10)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)

  if (Math.abs(now - timestamp) > WORKER_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' }
  }

  const expected = signWorkerRequest(secret, timestamp, input.method, input.path, input.rawBody)

  // Compare fixed-size digests so neither length nor prefix leaks through timing.
  if (!timingSafeEqual(digest(expected), digest(input.signatureHeader.trim()))) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  return { ok: true }
}

/** Reads at most `limit` bytes of the body; null when it is larger. */
async function readBoundedBody(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > limit) return null
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Reads the raw body once (bounded) and verifies the request. Returns the body text on
 * success so the handler parses exactly the bytes that were signed.
 */
export async function authenticateWorkerRequest(
  request: Request,
): Promise<{ ok: true; rawBody: string } | { ok: false; reason: WorkerAuthFailure }> {
  const rawBody = await readBoundedBody(request, MAX_WORKER_BODY_BYTES)
  if (rawBody === null) return { ok: false, reason: 'body_too_large' }
  const result = verifyWorkerRequest({
    method: request.method,
    path: new URL(request.url).pathname,
    rawBody,
    timestampHeader: request.headers.get(WORKER_TIMESTAMP_HEADER),
    signatureHeader: request.headers.get(WORKER_SIGNATURE_HEADER),
  })

  return result.ok ? { ok: true, rawBody } : result
}

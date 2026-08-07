import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC signature verification for inbound webhooks.
 *
 * Webhook endpoints sit outside the session gate — they have no cookie to
 * authenticate with — so the signature *is* the authentication. Without it, anyone who
 * discovers the URL can flip newsletter subscription state for any address or inject
 * contacts straight past Row Level Security, because the handler writes with the
 * service-role key.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT — the exact header name and encoding must be confirmed against the
 * EmailOctopus documentation before go-live. Two common schemes are supported here:
 *
 *   t=<unix_seconds>,v1=<hex hmac of "timestamp.body">   (replay-resistant)
 *   sha256=<hex hmac of body>                            (no replay defence)
 *
 * If EmailOctopus uses base64, a different digest, or a different signed payload, the
 * change is confined to `parseSignatureHeader` and `computeDigest` below. This could
 * not be verified here — no webhook secret or live endpoint was available.
 * ---------------------------------------------------------------------------
 */

/** How far a signed timestamp may drift before the request is treated as a replay. */
export const DEFAULT_TOLERANCE_SECONDS = 300

export type ParsedSignature = {
  timestamp: number | null
  signatures: string[]
}

export type VerifyResult =
  | { valid: true }
  | {
      valid: false
      reason:
        | 'missing_signature'
        | 'malformed_signature'
        | 'secret_not_configured'
        | 'timestamp_out_of_tolerance'
        | 'signature_mismatch'
    }

const HEX = /^[0-9a-f]+$/i

/** Parses the signature header into a timestamp (if present) and candidate digests. */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignature | null {
  if (typeof header !== 'string') return null

  const trimmed = header.trim()
  if (trimmed === '') return null

  // Bare hex digest, no scheme prefix.
  if (HEX.test(trimmed)) {
    return { timestamp: null, signatures: [trimmed] }
  }

  const parts = trimmed.split(',').map((part) => part.trim())
  let timestamp: number | null = null
  let sawTimestampKey = false
  const signatures: string[] = []

  for (const part of parts) {
    const separator = part.indexOf('=')
    if (separator === -1) continue

    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()

    if (value === '') continue

    if (key === 't') {
      sawTimestampKey = true
      const parsed = Number.parseInt(value, 10)
      // Guard against `t=abc`: an unparseable timestamp must not silently become
      // "no timestamp", which would skip the replay check entirely.
      if (!Number.isFinite(parsed)) return null
      timestamp = parsed
    } else if (key === 'v1' || key === 'sha256') {
      signatures.push(value)
    }
  }

  if (signatures.length === 0) {
    return null
  }

  if (sawTimestampKey && timestamp === null) {
    return null
  }

  return { timestamp, signatures }
}

function computeDigest(secret: string, rawBody: string, timestamp: number | null): string {
  const payload = timestamp === null ? rawBody : `${timestamp}.${rawBody}`

  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
}

/** Constant-time comparison that tolerates length and encoding mismatches. */
function safeEquals(a: string, b: string): boolean {
  // timingSafeEqual throws when the buffers differ in length, so compare lengths
  // first. Length is not secret — the digest size is fixed and public.
  if (a.length !== b.length) return false

  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
  } catch {
    return false
  }
}

export function verifyWebhookSignature({
  rawBody,
  signatureHeader,
  secret,
  nowSeconds,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}: {
  /** The exact bytes received. Re-serialising parsed JSON changes the digest. */
  rawBody: string
  signatureHeader: string | null | undefined
  secret: string
  nowSeconds: number
  toleranceSeconds?: number
}): VerifyResult {
  // An unset secret must never mean "accept everything".
  if (!secret) {
    return { valid: false, reason: 'secret_not_configured' }
  }

  if (signatureHeader === null || signatureHeader === undefined || signatureHeader === '') {
    return { valid: false, reason: 'missing_signature' }
  }

  const parsed = parseSignatureHeader(signatureHeader)

  if (!parsed) {
    return { valid: false, reason: 'malformed_signature' }
  }

  if (parsed.timestamp !== null) {
    const drift = Math.abs(nowSeconds - parsed.timestamp)

    if (drift > toleranceSeconds) {
      return { valid: false, reason: 'timestamp_out_of_tolerance' }
    }
  }

  const expected = computeDigest(secret, rawBody, parsed.timestamp)

  // Several candidates may be offered while a secret is being rotated.
  const matched = parsed.signatures.some(
    (candidate) => safeEquals(candidate, expected) || safeEquals(candidate.toLowerCase(), expected)
  )

  return matched ? { valid: true } : { valid: false, reason: 'signature_mismatch' }
}

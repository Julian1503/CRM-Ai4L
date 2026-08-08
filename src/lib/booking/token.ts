import { createHash, randomBytes } from 'node:crypto'

/**
 * Booking link tokens.
 *
 * Each campaign recipient gets a unique, single-use, expiring token. The token is the
 * only thing in the booking URL — a contact's UUID must never appear in an email link,
 * because email links leak: they are forwarded, logged by mail gateways, and captured
 * in link-scanning proxies. A guessable or enumerable identifier there would let a
 * stranger claim a consultation attributed to someone else.
 *
 * Only the SHA-256 hash is stored. A database leak therefore yields no working links.
 */

/** 30 days: long enough for a real sales cycle, short enough that old links die. */
export const BOOKING_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 32 bytes of entropy, base64url encoded to 43 URL-safe characters. */
const TOKEN_BYTES = 32

export type GeneratedToken = {
  /** Goes in the email link. Never stored. */
  token: string
  /** Stored in the database. */
  hash: string
}

export function hashBookingToken(token: string): string {
  return createHash('sha256').update(token.trim(), 'utf8').digest('hex')
}

export function generateBookingToken(): GeneratedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')

  return { token, hash: hashBookingToken(token) }
}

export type BookingUsability =
  | { usable: true }
  | { usable: false; reason: 'expired' | 'already_used' | 'cancelled' }

type BookingLike = {
  expires_at: string | null
  consumed_at: string | null
  status: string
}

/**
 * Whether a booking link can still be acted on.
 *
 * Fails closed on every ambiguity — a malformed row must not become a permanent free
 * booking link.
 */
export function isBookingUsable(booking: BookingLike, nowMs: number): BookingUsability {
  if (booking.status === 'cancelled') {
    return { usable: false, reason: 'cancelled' }
  }

  // Single-use. Without this, one forwarded link books repeatedly against the same
  // promotion code.
  if (booking.consumed_at) {
    return { usable: false, reason: 'already_used' }
  }

  if (!booking.expires_at) {
    return { usable: false, reason: 'expired' }
  }

  const expiresAt = Date.parse(booking.expires_at)

  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return { usable: false, reason: 'expired' }
  }

  return { usable: true }
}

/** Expiry timestamp for a token minted now. */
export function bookingExpiryFrom(nowMs: number): string {
  return new Date(nowMs + BOOKING_TOKEN_TTL_MS).toISOString()
}

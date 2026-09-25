import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Preference-centre links.
 *
 * Every marketing email carries a link that lets the reader change or withdraw their
 * consent. That link has requirements the booking token cannot meet, and the
 * differences are the whole design:
 *
 * - **It never expires.** A booking link dies after 30 days because a stale offer
 *   should. An unsubscribe link in an email from two years ago must still work — a
 *   dead one is a Spam Act problem, not an inconvenience.
 * - **It is reusable.** Booking tokens are single-use so a reservation cannot be
 *   claimed twice. Here the reader may unsubscribe, change their mind, and come back.
 * - **It is deterministic.** The same contact always gets the same link, so the sync
 *   can write it to the provider as an ordinary contact field and every send — ours or
 *   a newsletter the client sends from the EmailOctopus dashboard — carries the same
 *   working URL without minting anything.
 *
 * All three rule out a random token stored per use, which is why this is a signature
 * rather than a lookup: no row to expire, nothing to write at send time, and no state
 * that can drift from the contact it points at.
 *
 * **On the contact id being visible in the URL.** The booking token hides it, because
 * there an id in the link is a credential — a guessable one would let a stranger claim
 * somebody else's consultation. Here the signature is the credential and the id grants
 * nothing on its own: without a matching HMAC it opens nothing, and with one the holder
 * is already the person the link was sent to. What is worth protecting is the ability
 * to *forge* a link for an address you do not have, and that is what the signature
 * denies.
 */

/**
 * Scheme version, carried in the token so the secret can be rotated without breaking
 * every link ever sent. A future `v2` verifies against a new secret while `v1` keeps
 * working, or is retired deliberately.
 */
const TOKEN_VERSION = 'v1'

/** Bytes of the digest kept. 128 bits is far past forgeable and keeps the URL short. */
const SIGNATURE_BYTES = 16

export class MissingPreferencesSecretError extends Error {
  constructor() {
    super(
      'PREFERENCES_SECRET is not configured. Preference links cannot be signed or verified.'
    )
    this.name = 'MissingPreferencesSecretError'
  }
}

function readSecret(): string {
  const secret = process.env.PREFERENCES_SECRET?.trim()

  // Thrown rather than defaulted. A blank secret would still produce tokens that
  // verify against each other, so every link in the world would be forgeable and
  // nothing would look wrong.
  if (!secret) {
    throw new MissingPreferencesSecretError()
  }

  return secret
}

function sign(contactId: string): string {
  return createHmac('sha256', readSecret())
    .update(`${TOKEN_VERSION}:${contactId}`, 'utf8')
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString('base64url')
}

/** The token for a contact's preference link. Stable for as long as the secret is. */
export function mintPreferencesToken(contactId: string): string {
  const id = contactId.trim()

  if (!id) {
    throw new Error('mintPreferencesToken: a contact id is required')
  }

  return `${TOKEN_VERSION}.${id}.${sign(id)}`
}

/**
 * The contact a token names, or null when it does not verify.
 *
 * Never throws for a bad token — a malformed one and a forged one are the same answer
 * to the caller, and both render the same page. It does throw when the *server* is
 * misconfigured, because that is not the visitor's fault and must not be reported to
 * them as an invalid link.
 */
export function readPreferencesToken(token: string): string | null {
  const parts = token.trim().split('.')

  if (parts.length !== 3) return null

  const [version, contactId, signature] = parts

  if (version !== TOKEN_VERSION || !contactId || !signature) return null

  const expected = Buffer.from(sign(contactId), 'utf8')
  const provided = Buffer.from(signature, 'utf8')

  // Length is checked first because timingSafeEqual throws on a mismatch, and the
  // length of a signature is not a secret.
  if (expected.length !== provided.length) return null

  return timingSafeEqual(expected, provided) ? contactId : null
}

/** The URL to put in an email. `origin` has no trailing slash. */
export function preferencesUrl(origin: string, contactId: string): string {
  return `${origin.replace(/\/$/, '')}/preferences/${mintPreferencesToken(contactId)}`
}

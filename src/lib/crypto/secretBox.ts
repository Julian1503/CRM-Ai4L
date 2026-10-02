import 'server-only'

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Authenticated encryption for secrets stored at rest (social access/refresh tokens).
 *
 * AES-256-GCM with a fresh 12-byte IV per value. The envelope is self-describing:
 *
 *   v<keyVersion>:<iv base64url>:<tag base64url>:<ciphertext base64url>
 *
 * so a key can be rotated without re-encrypting everything at once: new values use
 * CONTENT_TOKEN_ENCRYPTION_KEY at CONTENT_TOKEN_ENCRYPTION_KEY_VERSION, and older values
 * still decrypt with CONTENT_TOKEN_ENCRYPTION_KEY_V<n> for the version they carry.
 *
 * An optional `aad` (additional authenticated data) binds a ciphertext to where it is
 * stored — e.g. `social_account:<id>:access_token` — so a value copied into another row
 * fails to decrypt instead of silently authenticating as someone else's token.
 *
 * Everything fails closed: a missing or malformed key, an unknown version, a tampered
 * value or a wrong AAD raises, and no error message ever contains key or plaintext.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_KEY_VERSION = 9999
const ENVELOPE_PATTERN = /^v(\d{1,4}):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]*)$/

export const ENCRYPTION_KEY_ENV = 'CONTENT_TOKEN_ENCRYPTION_KEY'
export const ENCRYPTION_KEY_VERSION_ENV = 'CONTENT_TOKEN_ENCRYPTION_KEY_VERSION'

type Env = Record<string, string | undefined>

export class SecretBoxConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretBoxConfigError'
  }
}

export class SecretBoxDecryptError extends Error {
  constructor(message = 'The stored secret could not be decrypted.') {
    super(message)
    this.name = 'SecretBoxDecryptError'
  }
}

export type EncryptionKey = { version: number; key: Buffer }

function decodeKey(raw: string | undefined, name: string): Buffer {
  const value = raw?.trim()
  if (!value) throw new SecretBoxConfigError(`${name} is not configured.`)

  const key = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxConfigError(`${name} must be ${KEY_BYTES} bytes, base64 encoded.`)
  }
  return key
}

function parseVersion(raw: string | undefined): number {
  const value = raw?.trim() ?? ''
  const version = /^\d{1,4}$/.test(value) ? Number.parseInt(value, 10) : Number.NaN

  if (!Number.isInteger(version) || version < 1 || version > MAX_KEY_VERSION) {
    throw new SecretBoxConfigError(`${ENCRYPTION_KEY_VERSION_ENV} must be an integer between 1 and ${MAX_KEY_VERSION}.`)
  }
  return version
}

/** The key new values are encrypted with. Throws when unset or malformed. */
export function readCurrentKey(env: Env = process.env): EncryptionKey {
  return {
    version: parseVersion(env[ENCRYPTION_KEY_VERSION_ENV]),
    key: decodeKey(env[ENCRYPTION_KEY_ENV], ENCRYPTION_KEY_ENV),
  }
}

/** The key for a stored version: the current key, or CONTENT_TOKEN_ENCRYPTION_KEY_V<n>. */
export function readKeyForVersion(version: number, env: Env = process.env): Buffer {
  const current = readCurrentKey(env)
  if (version === current.version) return current.key

  const name = `${ENCRYPTION_KEY_ENV}_V${version}`
  return decodeKey(env[name], name)
}

/** True when a current key is configured and valid. Never throws. */
export function isSecretBoxConfigured(env: Env = process.env): boolean {
  try {
    readCurrentKey(env)
    return true
  } catch {
    return false
  }
}

export function encryptSecret(plaintext: string, aad: string | null = null, env: Env = process.env): string {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new TypeError('encryptSecret needs a non-empty string.')
  }
  const { version, key } = readCurrentKey(env)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  if (aad !== null) cipher.setAAD(Buffer.from(aad, 'utf8'))

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `v${version}:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`
}

/** The key version an envelope was written with, or null when it is not an envelope. */
export function envelopeKeyVersion(envelope: string): number | null {
  const match = ENVELOPE_PATTERN.exec(envelope)
  return match ? Number.parseInt(match[1], 10) : null
}

export function decryptSecret(envelope: string, aad: string | null = null, env: Env = process.env): string {
  const match = typeof envelope === 'string' ? ENVELOPE_PATTERN.exec(envelope) : null
  if (!match) throw new SecretBoxDecryptError('The stored secret is not a valid envelope.')

  const key = readKeyForVersion(Number.parseInt(match[1], 10), env)
  const iv = Buffer.from(match[2], 'base64url')
  const tag = Buffer.from(match[3], 'base64url')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxDecryptError('The stored secret is not a valid envelope.')
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
    if (aad !== null) decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(match[4], 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw new SecretBoxDecryptError()
  }
}

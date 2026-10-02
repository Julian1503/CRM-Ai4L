/** @jest-environment node */
import { randomBytes } from 'node:crypto'

import {
  decryptSecret,
  encryptSecret,
  envelopeKeyVersion,
  isSecretBoxConfigured,
  readCurrentKey,
  readKeyForVersion,
  SecretBoxConfigError,
  SecretBoxDecryptError,
} from './secretBox'

const KEY_1 = randomBytes(32).toString('base64')
const KEY_2 = randomBytes(32).toString('base64url')

const ENV_V1 = { CONTENT_TOKEN_ENCRYPTION_KEY: KEY_1, CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '1' }
const ENV_V2 = {
  CONTENT_TOKEN_ENCRYPTION_KEY: KEY_2,
  CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '2',
  CONTENT_TOKEN_ENCRYPTION_KEY_V1: KEY_1,
}

describe('secretBox', () => {
  it('round-trips a secret and never stores the plaintext', () => {
    const envelope = encryptSecret('token-123', null, ENV_V1)

    expect(envelope).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
    expect(envelope).not.toContain('token-123')
    expect(decryptSecret(envelope, null, ENV_V1)).toBe('token-123')
  })

  it('uses a fresh IV so equal plaintexts encrypt differently', () => {
    expect(encryptSecret('same', null, ENV_V1)).not.toBe(encryptSecret('same', null, ENV_V1))
  })

  it('binds the ciphertext to its additional authenticated data', () => {
    const envelope = encryptSecret('token', 'social_account:a:access_token', ENV_V1)

    expect(decryptSecret(envelope, 'social_account:a:access_token', ENV_V1)).toBe('token')
    expect(() => decryptSecret(envelope, 'social_account:b:access_token', ENV_V1)).toThrow(SecretBoxDecryptError)
    expect(() => decryptSecret(envelope, null, ENV_V1)).toThrow(SecretBoxDecryptError)
  })

  it('decrypts values written under an older key version after rotation', () => {
    const old = encryptSecret('legacy', null, ENV_V1)
    const fresh = encryptSecret('fresh', null, ENV_V2)

    expect(envelopeKeyVersion(fresh)).toBe(2)
    expect(decryptSecret(old, null, ENV_V2)).toBe('legacy')
    expect(decryptSecret(fresh, null, ENV_V2)).toBe('fresh')
  })

  it('fails closed when an old version key is missing', () => {
    const old = encryptSecret('legacy', null, ENV_V1)
    const rotatedWithoutOld = { CONTENT_TOKEN_ENCRYPTION_KEY: KEY_2, CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '2' }

    expect(() => decryptSecret(old, null, rotatedWithoutOld)).toThrow(SecretBoxConfigError)
  })

  it('refuses tampered ciphertext, tags and malformed envelopes', () => {
    const [version, iv, tag, ct] = encryptSecret('secret', null, ENV_V1).split(':')
    const flipped = Buffer.from(ct, 'base64url')
    const tampered = Buffer.from(flipped.map((byte, index) => (index === 0 ? byte ^ 1 : byte))).toString('base64url')

    expect(() => decryptSecret([version, iv, tag, tampered].join(':'), null, ENV_V1)).toThrow(SecretBoxDecryptError)
    expect(() => decryptSecret([version, iv, 'AAAA', ct].join(':'), null, ENV_V1)).toThrow(SecretBoxDecryptError)
    expect(() => decryptSecret('plaintext-token', null, ENV_V1)).toThrow(SecretBoxDecryptError)
    expect(() => decryptSecret(42 as unknown as string, null, ENV_V1)).toThrow(SecretBoxDecryptError)
    expect(envelopeKeyVersion('nope')).toBeNull()
  })

  it('fails closed without a valid key or version', () => {
    expect(() => readCurrentKey({})).toThrow(SecretBoxConfigError)
    expect(() => readCurrentKey({ CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '1' })).toThrow(/not configured/)
    expect(() =>
      readCurrentKey({ CONTENT_TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=', CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '1' })
    ).toThrow(/32 bytes/)
    expect(() => readCurrentKey({ CONTENT_TOKEN_ENCRYPTION_KEY: KEY_1, CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '0' })).toThrow(
      /integer/
    )
    expect(() => readCurrentKey({ CONTENT_TOKEN_ENCRYPTION_KEY: KEY_1, CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: 'x' })).toThrow(
      /integer/
    )
    expect(() => encryptSecret('x', null, {})).toThrow(SecretBoxConfigError)
    expect(isSecretBoxConfigured({})).toBe(false)
    expect(isSecretBoxConfigured(ENV_V1)).toBe(true)
  })

  it('never puts key material in an error message', () => {
    const bad = { CONTENT_TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=', CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '1' }

    expect(() => readCurrentKey(bad)).toThrow(expect.objectContaining({ message: expect.not.stringContaining('c2hvcnQ') }))
  })

  it('returns the current key for its own version and reads older ones by name', () => {
    expect(readKeyForVersion(2, ENV_V2).equals(Buffer.from(KEY_2, 'base64url'))).toBe(true)
    expect(readKeyForVersion(1, ENV_V2).equals(Buffer.from(KEY_1, 'base64'))).toBe(true)
  })

  it('refuses to encrypt an empty value', () => {
    expect(() => encryptSecret('', null, ENV_V1)).toThrow(TypeError)
  })

  it('reads process.env by default', () => {
    const original = process.env
    process.env = { ...original, ...ENV_V1 }
    try {
      expect(decryptSecret(encryptSecret('env'))).toBe('env')
    } finally {
      process.env = original
    }
  })
})

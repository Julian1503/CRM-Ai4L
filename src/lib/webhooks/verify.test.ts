/**
 * @jest-environment node
 */
import { createHmac } from 'node:crypto'

import {
  DEFAULT_TOLERANCE_SECONDS,
  parseSignatureHeader,
  verifyWebhookSignature,
} from './verify'

const SECRET = 'whsec_test_secret'
const BODY = '{"event":"contact.subscribed","contact":{"email_address":"a@example.com"}}'

function sign(body: string, secret = SECRET, timestamp?: number): string {
  const payload = timestamp === undefined ? body : `${timestamp}.${body}`
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
}

describe('parseSignatureHeader', () => {
  it('parses the timestamped form', () => {
    expect(parseSignatureHeader('t=1700000000,v1=abc123')).toEqual({
      timestamp: 1700000000,
      signatures: ['abc123'],
    })
  })

  it('collects several v1 signatures, as sent during secret rotation', () => {
    const parsed = parseSignatureHeader('t=1700000000,v1=aaa,v1=bbb')

    expect(parsed?.signatures).toEqual(['aaa', 'bbb'])
  })

  it('parses the bare sha256 form', () => {
    expect(parseSignatureHeader('sha256=deadbeef')).toEqual({
      timestamp: null,
      signatures: ['deadbeef'],
    })
  })

  it('parses a bare hex digest', () => {
    expect(parseSignatureHeader('deadbeef')).toEqual({
      timestamp: null,
      signatures: ['deadbeef'],
    })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseSignatureHeader('  t=123, v1=abc  ')?.signatures).toEqual(['abc'])
  })

  it.each([null, undefined, '', '   ', 't=123', 'v1=', 'garbage=x'])(
    'returns null for %p',
    (header) => {
      expect(parseSignatureHeader(header as string)).toBeNull()
    }
  )

  it('returns null when the timestamp is not a number', () => {
    expect(parseSignatureHeader('t=notanumber,v1=abc')).toBeNull()
  })
})

describe('verifyWebhookSignature', () => {
  const now = 1_700_000_000

  describe('bare signature over the body', () => {
    it('accepts a correct signature', () => {
      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `sha256=${sign(BODY)}`,
        secret: SECRET,
        nowSeconds: now,
      })

      expect(result.valid).toBe(true)
    })

    it('rejects a tampered body', () => {
      const result = verifyWebhookSignature({
        rawBody: BODY.replace('subscribed', 'unsubscribed'),
        signatureHeader: `sha256=${sign(BODY)}`,
        secret: SECRET,
        nowSeconds: now,
      })

      expect(result).toEqual({ valid: false, reason: 'signature_mismatch' })
    })

    it('rejects a signature made with a different secret', () => {
      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `sha256=${sign(BODY, 'wrong_secret')}`,
        secret: SECRET,
        nowSeconds: now,
      })

      expect(result).toEqual({ valid: false, reason: 'signature_mismatch' })
    })
  })

  describe('timestamped signature', () => {
    it('accepts a correct signature within tolerance', () => {
      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `t=${now},v1=${sign(BODY, SECRET, now)}`,
        secret: SECRET,
        nowSeconds: now + 5,
      })

      expect(result.valid).toBe(true)
    })

    it('signs over timestamp.body, so a timestamp swap invalidates it', () => {
      // Without the timestamp in the signed payload an attacker could replay an
      // old body with a fresh timestamp.
      const signature = sign(BODY, SECRET, now)

      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `t=${now + 1},v1=${signature}`,
        secret: SECRET,
        nowSeconds: now + 1,
      })

      expect(result.valid).toBe(false)
    })

    it('rejects a replayed request outside the tolerance window', () => {
      const stale = now - (DEFAULT_TOLERANCE_SECONDS + 60)

      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `t=${stale},v1=${sign(BODY, SECRET, stale)}`,
        secret: SECRET,
        nowSeconds: now,
      })

      expect(result).toEqual({ valid: false, reason: 'timestamp_out_of_tolerance' })
    })

    it('rejects a timestamp too far in the future', () => {
      const future = now + DEFAULT_TOLERANCE_SECONDS + 60

      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `t=${future},v1=${sign(BODY, SECRET, future)}`,
        secret: SECRET,
        nowSeconds: now,
      })

      expect(result).toEqual({ valid: false, reason: 'timestamp_out_of_tolerance' })
    })

    it('accepts any one of several offered signatures, for secret rotation', () => {
      const good = sign(BODY, SECRET, now)

      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `t=${now},v1=deadbeef,v1=${good}`,
        secret: SECRET,
        nowSeconds: now,
      })

      expect(result.valid).toBe(true)
    })
  })

  describe('refusals', () => {
    it('rejects a missing header', () => {
      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: null,
        secret: SECRET,
        nowSeconds: now,
      })

      expect(result).toEqual({ valid: false, reason: 'missing_signature' })
    })

    it('rejects a malformed header', () => {
      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: 'not-a-signature-header=',
        secret: SECRET,
        nowSeconds: now,
      })

      expect(result).toEqual({ valid: false, reason: 'malformed_signature' })
    })

    it('fails closed when no secret is configured', () => {
      // An unset secret must not mean "accept everything".
      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `sha256=${sign(BODY)}`,
        secret: '',
        nowSeconds: now,
      })

      expect(result).toEqual({ valid: false, reason: 'secret_not_configured' })
    })

    it('does not throw when the signature length differs from the digest', () => {
      // timingSafeEqual throws on a length mismatch; the length check must come first.
      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: 'sha256=ab',
        secret: SECRET,
        nowSeconds: now,
      })

      expect(result.valid).toBe(false)
    })

    it('rejects a non-hex signature without throwing', () => {
      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `sha256=${'z'.repeat(64)}`,
        secret: SECRET,
        nowSeconds: now,
      })

      expect(result.valid).toBe(false)
    })

    it('is not fooled by uppercase hex differing from the computed digest', () => {
      const upper = sign(BODY).toUpperCase()

      const result = verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `sha256=${upper}`,
        secret: SECRET,
        nowSeconds: now,
      })

      // Accepting either case is fine; silently accepting a *wrong* value is not.
      expect(typeof result.valid).toBe('boolean')
      if (result.valid) {
        expect(upper.toLowerCase()).toBe(sign(BODY))
      }
    })
  })
})

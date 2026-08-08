/**
 * @jest-environment node
 */
import {
  BOOKING_TOKEN_TTL_MS,
  generateBookingToken,
  hashBookingToken,
  isBookingUsable,
} from './token'

describe('generateBookingToken', () => {
  it('returns a raw token for the link and a hash for storage', () => {
    const { token, hash } = generateBookingToken()

    expect(token).toEqual(expect.any(String))
    expect(hash).toEqual(expect.any(String))
    expect(hash).not.toBe(token)
  })

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateBookingToken().token))

    expect(tokens.size).toBe(500)
  })

  it('carries enough entropy to be unguessable', () => {
    // 32 random bytes, base64url encoded. Anything materially shorter would be
    // brute-forceable, and the token is the only thing standing between a stranger
    // and a booking attributed to someone else.
    const { token } = generateBookingToken()

    expect(token.length).toBeGreaterThanOrEqual(43)
  })

  it('is URL-safe, so it survives an email link unescaped', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateBookingToken().token).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('stores a hash, so a database leak does not yield working links', () => {
    const { token, hash } = generateBookingToken()

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(token)
  })
})

describe('hashBookingToken', () => {
  it('is deterministic', () => {
    const { token } = generateBookingToken()

    expect(hashBookingToken(token)).toBe(hashBookingToken(token))
  })

  it('differs for different tokens', () => {
    const a = generateBookingToken()
    const b = generateBookingToken()

    expect(hashBookingToken(a.token)).not.toBe(hashBookingToken(b.token))
  })

  it('matches the hash produced at generation', () => {
    const { token, hash } = generateBookingToken()

    expect(hashBookingToken(token)).toBe(hash)
  })

  it('is not fooled by a whitespace-padded token', () => {
    const { token, hash } = generateBookingToken()

    expect(hashBookingToken(` ${token} `)).toBe(hash)
  })
})

describe('isBookingUsable', () => {
  const now = new Date('2026-08-08T12:00:00.000Z').getTime()
  const future = new Date(now + 60_000).toISOString()
  const past = new Date(now - 60_000).toISOString()

  it('accepts an unused, unexpired booking', () => {
    expect(isBookingUsable({ expires_at: future, consumed_at: null, status: 'pending' }, now)).toEqual(
      { usable: true }
    )
  })

  it('rejects an expired booking', () => {
    expect(
      isBookingUsable({ expires_at: past, consumed_at: null, status: 'pending' }, now)
    ).toEqual({ usable: false, reason: 'expired' })
  })

  it('rejects a booking that was already used', () => {
    // Single-use: otherwise a forwarded link books repeatedly on one promotion code.
    expect(
      isBookingUsable(
        { expires_at: future, consumed_at: '2026-08-08T11:00:00.000Z', status: 'booked' },
        now
      )
    ).toEqual({ usable: false, reason: 'already_used' })
  })

  it('rejects a cancelled booking', () => {
    expect(
      isBookingUsable({ expires_at: future, consumed_at: null, status: 'cancelled' }, now)
    ).toEqual({ usable: false, reason: 'cancelled' })
  })

  it('treats a missing expiry as expired rather than eternal', () => {
    // Failing open here would make a malformed row a permanent free booking link.
    expect(
      isBookingUsable({ expires_at: null, consumed_at: null, status: 'pending' }, now)
    ).toEqual({ usable: false, reason: 'expired' })
  })

  it('expires exactly at the boundary', () => {
    const boundary = new Date(now).toISOString()

    expect(
      isBookingUsable({ expires_at: boundary, consumed_at: null, status: 'pending' }, now).usable
    ).toBe(false)
  })

  it('uses a TTL long enough to be useful but not indefinite', () => {
    const days = BOOKING_TOKEN_TTL_MS / (24 * 60 * 60 * 1000)

    expect(days).toBeGreaterThanOrEqual(7)
    expect(days).toBeLessThanOrEqual(60)
  })
})

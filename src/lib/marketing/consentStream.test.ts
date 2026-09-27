import { parseConsentStream, readConsentStream } from './consentStream'

describe('readConsentStream', () => {
  it('reads the two streams a request may name', () => {
    expect(readConsentStream('newsletter')).toBe('newsletter')
    expect(readConsentStream('programs')).toBe('programs')
  })

  it.each([undefined, null, '', 'PROGRAMS', 'courses', 42, {}])(
    'falls back to the newsletter for %p',
    (value) => {
      // The stream decides which consent an audience is counted against. Guessing
      // `programs` from an unrecognised value would widen the audience on the strength
      // of a typo; the newsletter is the narrower of the two, so an unclear request
      // reaches fewer people rather than more.
      expect(readConsentStream(value)).toBe('newsletter')
    }
  )
})

describe('parseConsentStream', () => {
  it('reads the two streams a request may name', () => {
    expect(parseConsentStream('newsletter')).toBe('newsletter')
    expect(parseConsentStream('programs')).toBe('programs')
  })

  it.each([undefined, null, '', 'PROGRAMS', 'courses', 42, {}])(
    'refuses to guess for %p',
    (value) => {
      // For callers that must be told explicitly — a campaign with no template has
      // nothing else to take its stream from, and a silent fallback is how every
      // course invitation ended up counted against the newsletter.
      expect(parseConsentStream(value)).toBeNull()
    }
  )
})

import { readConsentStream } from './consentStream'

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

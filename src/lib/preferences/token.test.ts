import {
  MissingPreferencesSecretError,
  mintPreferencesToken,
  preferencesUrl,
  readPreferencesToken,
} from './token'

const ORIGINAL_ENV = process.env
const CONTACT = '3f1c2a44-0000-4000-8000-000000000001'

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, PREFERENCES_SECRET: 'test-secret' }
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

describe('preference tokens', () => {
  it('round-trips the contact it was minted for', () => {
    expect(readPreferencesToken(mintPreferencesToken(CONTACT))).toBe(CONTACT)
  })

  it('is deterministic, so the same contact always gets the same link', () => {
    // The sync writes this into a provider field. A token that changed per call would
    // rewrite every contact on every run and put a different URL in each email.
    expect(mintPreferencesToken(CONTACT)).toBe(mintPreferencesToken(CONTACT))
  })

  it('does not expire or spend itself', () => {
    // Stated as a test because it is a requirement, not an accident: an unsubscribe
    // link in a two-year-old email has to keep working, and a reader may use it twice.
    const token = mintPreferencesToken(CONTACT)

    expect(readPreferencesToken(token)).toBe(CONTACT)
    expect(readPreferencesToken(token)).toBe(CONTACT)
  })

  it('refuses a token signed for a different contact', () => {
    // The attack this exists to stop: taking your own valid link and editing the id in
    // it to change somebody else's consent.
    const token = mintPreferencesToken(CONTACT)
    const other = token.replace(CONTACT, '3f1c2a44-0000-4000-8000-000000000002')

    expect(readPreferencesToken(other)).toBeNull()
  })

  it('refuses a token signed with a different secret', () => {
    const token = mintPreferencesToken(CONTACT)

    process.env.PREFERENCES_SECRET = 'rotated-secret'

    expect(readPreferencesToken(token)).toBeNull()
  })

  it.each([
    ['empty', ''],
    ['not a token', 'nope'],
    ['missing the signature', `v1.${CONTACT}`],
    ['an unknown scheme version', `v2.${CONTACT}.abcdef`],
    ['an empty signature', `v1.${CONTACT}.`],
    ['extra segments', `v1.${CONTACT}.sig.extra`],
  ])('returns null for %s rather than throwing', (_label, token) => {
    // A malformed token and a forged one are the same answer to the caller: they render
    // the same page, and neither is an error a visitor can act on.
    expect(readPreferencesToken(token)).toBeNull()
  })

  it('refuses a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws when the buffers differ in length; the length of a
    // signature is not a secret, so it is checked before the comparison.
    expect(readPreferencesToken(`v1.${CONTACT}.short`)).toBeNull()
  })

  it('fails loudly when the server has no secret', () => {
    // A blank secret would still sign and verify consistently, so every link in the
    // world would be forgeable and nothing would look broken.
    delete process.env.PREFERENCES_SECRET

    expect(() => mintPreferencesToken(CONTACT)).toThrow(MissingPreferencesSecretError)
    expect(() => readPreferencesToken(`v1.${CONTACT}.sig`)).toThrow(
      MissingPreferencesSecretError
    )
  })

  it('builds a link without a doubled slash', () => {
    expect(preferencesUrl('https://crm.example.com/', CONTACT)).toBe(
      `https://crm.example.com/preferences/${mintPreferencesToken(CONTACT)}`
    )
  })
})

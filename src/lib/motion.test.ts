import { REDUCED_MOTION_QUERY, prefersReducedMotion } from './motion'

describe('prefersReducedMotion', () => {
  const original = window.matchMedia

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: original,
    })
  })

  function stubMatchMedia(impl: unknown) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: impl,
    })
  }

  it('asks for the reduce preference specifically', () => {
    const matchMedia = jest.fn().mockReturnValue({ matches: false })
    stubMatchMedia(matchMedia)

    prefersReducedMotion()

    expect(matchMedia).toHaveBeenCalledWith(REDUCED_MOTION_QUERY)
  })

  it('is true when the user asked to reduce motion', () => {
    stubMatchMedia(jest.fn().mockReturnValue({ matches: true }))

    expect(prefersReducedMotion()).toBe(true)
  })

  it('is false when the user has no preference', () => {
    stubMatchMedia(jest.fn().mockReturnValue({ matches: false }))

    expect(prefersReducedMotion()).toBe(false)
  })

  it('animates rather than failing when matchMedia is absent', () => {
    // Server render, and older environments. A blank screen would be a worse outcome
    // than an unwanted fade.
    stubMatchMedia(undefined)

    expect(prefersReducedMotion()).toBe(false)
  })

  it('animates rather than failing when matchMedia throws', () => {
    stubMatchMedia(
      jest.fn(() => {
        throw new Error('unsupported query')
      })
    )

    expect(prefersReducedMotion()).toBe(false)
  })
})

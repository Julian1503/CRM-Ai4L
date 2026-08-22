/**
 * Reduced-motion preference.
 *
 * PRODUCT.md commits to honouring `prefers-reduced-motion` with instant transitions,
 * and WCAG 2.1 (2.3.3, AAA — but the stated product target) expects motion from
 * interaction to be suppressible. Five components drive GSAP timelines and none of them
 * checked, so the whole app animated regardless of the setting.
 *
 * CSS handles this with a media query, but these animations are written in JavaScript:
 * GSAP sets inline styles, which beat any stylesheet rule. The check has to happen
 * before the timeline is built.
 *
 * Every animation in this app is decorative — entrance fades, staggers, a count-up.
 * Skipping one leaves the element in its final rendered state, which is exactly what
 * "instant transition" means, so callers can simply return early.
 */

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Whether the user has asked for reduced motion.
 *
 * Returns false when there is no `matchMedia` — during SSR, and in test environments
 * that do not stub it. Defaulting to "animate" there is right: the server renders no
 * animation anyway, and the client re-checks on mount.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }

  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    // Some jsdom versions and older browsers throw on an unsupported query rather
    // than reporting a non-match. Treating that as "no preference" keeps the app
    // working; the alternative is a blank screen if an entrance animation is skipped
    // in a component that relies on it to become visible.
    return false
  }
}

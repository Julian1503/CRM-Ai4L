/**
 * Full-page navigation.
 *
 * Wrapped in a module so it can be mocked in tests: `window.location` is
 * non-configurable in current jsdom, so it cannot be replaced, and assigning to it
 * triggers a "not implemented" navigation error rather than something observable.
 *
 * Used for redirects to external origins (Stripe Checkout), where the Next.js router
 * is not applicable.
 */
export function navigateTo(url: string): void {
  window.location.href = url
}

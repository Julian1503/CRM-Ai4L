/**
 * Route classification for the authentication gate.
 *
 * Kept as pure functions rather than inline logic in proxy.ts so the security rules
 * are directly unit-testable — a mistake here silently exposes the whole CRM.
 */

/**
 * Routes reachable without a session.
 *
 * `/login` and `/auth/callback` exist so an unauthenticated user can sign in.
 *
 * `/book` and `/api/booking` are public by necessity: the visitor is a *lead* who has
 * no CRM account and never will. They are not unprotected — the booking token is the
 * credential (unguessable, single-use, expiring), checked on every request. See
 * src/lib/booking/token.ts.
 *
 * `/preferences` and `/api/preferences` are public for the same reason and then some:
 * the whole point is that somebody who wants no further email can act without an
 * account, and a login wall in front of an unsubscribe link is a Spam Act problem. The
 * signed token is the credential — see src/lib/preferences/token.ts.
 */
export const PUBLIC_PATHS = [
  '/login',
  '/auth/callback',
  '/book',
  '/api/booking',
  '/preferences',
  '/api/preferences',
] as const

/**
 * Third-party webhook endpoints. These carry no session cookie, so the proxy must let
 * them through — they authenticate themselves by signature verification instead.
 *
 * Deliberately an exact allowlist rather than a `/webhook` suffix match: a wildcard
 * would let any future route opt out of authentication just by being named `webhook`.
 *
 * Fail-closed by design — a new webhook is blocked until it is added here, which is the
 * safer direction to be wrong in.
 */
export const WEBHOOK_PATHS = [
  '/api/integrations/emailoctopus/webhook',
  '/api/stripe/webhook',
  '/api/calendly/webhook',
] as const

/**
 * Scheduled jobs. Called by Vercel Cron, which carries no session; each route checks
 * `Authorization: Bearer $CRON_SECRET` itself and fails closed without it.
 *
 * Exact allowlist, fail-closed, for the same reasons as WEBHOOK_PATHS.
 */
export const CRON_PATHS = ['/api/cron/newsletters'] as const

function normalise(pathname: string): string {
  // Treat '/x/' and '/x' identically, but keep the root as '/'.
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

/** True when the path is a public route or a sub-path of one. */
export function isPublicPath(pathname: string): boolean {
  const path = normalise(pathname)

  return PUBLIC_PATHS.some((publicPath) => path === publicPath || path.startsWith(`${publicPath}/`))
}

/** True only for an exact webhook endpoint. */
export function isWebhookPath(pathname: string): boolean {
  const path = normalise(pathname)

  return WEBHOOK_PATHS.some((webhookPath) => path === webhookPath)
}

/** True only for an exact scheduled-job endpoint. */
export function isCronPath(pathname: string): boolean {
  const path = normalise(pathname)

  return CRON_PATHS.some((cronPath) => path === cronPath)
}

/** True for API routes, which should receive a 401 rather than a redirect. */
export function isApiPath(pathname: string): boolean {
  const path = normalise(pathname)

  return path === '/api' || path.startsWith('/api/')
}

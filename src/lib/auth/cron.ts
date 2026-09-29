import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Scheduled-job authentication. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 *
 * The proxy lets cron paths through without a session (CRON_PATHS), so this check is
 * the only gate: it fails closed when the secret is unset, and compares digests so
 * neither the length nor a prefix of the secret leaks through timing.
 */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function isAuthorisedCronRequest(header: string | null): boolean {
  const secret = process.env.CRON_SECRET?.trim()

  if (!secret || !header) return false

  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`))
}

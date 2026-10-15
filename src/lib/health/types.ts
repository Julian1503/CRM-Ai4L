/**
 * Integration health contract (UX plan P1.5/P1.6), shared by the API and the Settings
 * cards. Client-safe: no server imports.
 *
 * A result never carries a secret, a key prefix or a provider's raw error body: summaries
 * and details are written here, from what was observed, in words an operator can act on.
 */

export type HealthState = 'ok' | 'degraded' | 'down' | 'not_configured'

export const HEALTH_CHECK_IDS = [
  'database',
  'signup',
  'emailoctopus',
  'stripe',
  'calendly',
  'ai',
  'content_engine',
  'cron',
] as const

export type HealthCheckId = (typeof HEALTH_CHECK_IDS)[number]

export type HealthResult = {
  id: HealthCheckId
  label: string
  state: HealthState
  summary: string
  /** ISO timestamp of when this check ran. */
  checkedAt: string
  details?: string[]
  /** The next thing to do, when there is one. */
  actionHint?: string
}

export const HEALTH_LABELS: Record<HealthCheckId, string> = {
  database: 'Database',
  signup: 'Sign-up policy',
  emailoctopus: 'EmailOctopus',
  stripe: 'Stripe',
  calendly: 'Calendly',
  ai: 'AI copy',
  content_engine: 'Content engine',
  cron: 'Scheduled jobs',
}

export const HEALTH_STATE_LABELS: Record<HealthState, string> = {
  ok: 'Working',
  degraded: 'Needs attention',
  down: 'Not working',
  not_configured: 'Not set up',
}

export function isHealthCheckId(value: unknown): value is HealthCheckId {
  return typeof value === 'string' && (HEALTH_CHECK_IDS as readonly string[]).includes(value)
}

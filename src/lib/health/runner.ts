import { checkCron, checkDatabase, checkSignupPolicy } from './coreChecks'
import type { HealthCheck, HealthDeps } from './deps'
import { checkAi, checkCalendly, checkContentEngine, checkEmailOctopus, checkStripe } from './providerChecks'
import { HEALTH_CHECK_IDS, HEALTH_LABELS, type HealthCheckId, type HealthResult } from './types'

/** One check never holds the page longer than this. */
export const CHECK_TIMEOUT_MS = 8000
/** Each outbound request within a check. */
export const REQUEST_TIMEOUT_MS = 5000

export const HEALTH_CHECKS: Record<HealthCheckId, HealthCheck> = {
  database: checkDatabase,
  signup: checkSignupPolicy,
  emailoctopus: checkEmailOctopus,
  stripe: checkStripe,
  calendly: checkCalendly,
  ai: checkAi,
  content_engine: checkContentEngine,
  cron: checkCron,
}

/** A fetch that gives up after `ms`, so one slow provider cannot stall the screen. */
export function timedFetch(ms: number = REQUEST_TIMEOUT_MS, base: typeof fetch = fetch) {
  return (url: string, init: RequestInit = {}) => base(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(ms) })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Runs one check. A check that throws or runs out of time is reported as down with a
 * fixed message: the exception can carry a provider's response or a request detail.
 */
export async function runHealthCheck(id: HealthCheckId, deps: HealthDeps, timeoutMs = CHECK_TIMEOUT_MS): Promise<HealthResult> {
  const base = { id, label: HEALTH_LABELS[id] }
  try {
    const outcome = await withTimeout(HEALTH_CHECKS[id](deps), timeoutMs)
    return { ...base, ...outcome, checkedAt: deps.now().toISOString() }
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'timeout'
    console.error(`Health check ${id} failed:`, timedOut ? 'timeout' : error instanceof Error ? error.name : 'unknown error')
    return {
      ...base,
      state: 'down',
      summary: timedOut ? 'The check did not finish in time.' : 'The check could not be completed.',
      checkedAt: deps.now().toISOString(),
      actionHint: 'Test again in a moment. If it keeps failing, check the service and the server log.',
    }
  }
}

export function runAllHealthChecks(deps: HealthDeps): Promise<HealthResult[]> {
  return Promise.all(HEALTH_CHECK_IDS.map((id) => runHealthCheck(id, deps)))
}

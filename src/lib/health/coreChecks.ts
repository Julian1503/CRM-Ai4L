import type { LastCronRuns } from './cronRuns'
import type { CheckOutcome, HealthDeps } from './deps'

/**
 * Checks of the CRM's own platform: the database (and the membership function every
 * policy depends on), the public sign-up setting, and the scheduled jobs.
 */

const SLOW_DATABASE_MS = 2000

export async function checkDatabase(deps: HealthDeps): Promise<CheckOutcome> {
  const started = Date.now()
  const { data, error } = await deps.db.rpc('is_crm_member')
  const elapsed = Date.now() - started

  if (error) {
    return {
      state: 'down',
      summary: 'The database did not answer the membership check.',
      actionHint: 'Check the Supabase project status and the deployment environment variables.',
    }
  }
  if (data !== true) {
    return {
      state: 'degraded',
      summary: 'The database is reachable, but it does not recognise your membership.',
      actionHint: 'Ask an administrator to check your CRM membership.',
    }
  }

  const details = [`Answered in ${elapsed} ms.`]
  if (elapsed > SLOW_DATABASE_MS) {
    return { state: 'degraded', summary: 'The database is reachable but slow.', details }
  }
  return { state: 'ok', summary: 'Reachable, and your membership is active.', details }
}

/**
 * The CRM is invite-only: public sign-up must be off in Supabase Auth. Read from the
 * public `/auth/v1/settings` endpoint, the same answer scripts/preflight.mjs checks.
 */
export async function checkSignupPolicy(deps: HealthDeps): Promise<CheckOutcome> {
  const url = deps.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const anonKey = deps.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  if (!url || !anonKey) {
    return {
      state: 'not_configured',
      summary: 'The Supabase project is not configured in this deployment.',
      actionHint: 'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    }
  }

  const response = await deps.fetch(`${url.replace(/\/+$/, '')}/auth/v1/settings`, { headers: { apikey: anonKey } })
  if (!response.ok) {
    return { state: 'degraded', summary: 'The sign-up setting could not be read.', details: [`Supabase Auth answered HTTP ${response.status}.`] }
  }

  const settings = (await response.json().catch(() => null)) as { disable_signup?: unknown } | null
  if (settings?.disable_signup === true) {
    return { state: 'ok', summary: 'Public sign-up is off. People join by invitation only.' }
  }
  return {
    state: 'degraded',
    summary: 'Public sign-up is open: anyone with the address can create an account.',
    details: ['They cannot see CRM data without an approved membership, but the account exists.'],
    actionHint: 'In Supabase → Authentication → Sign In / Providers, turn off "Allow new users to sign up".',
  }
}

/** A daily schedule plus slack: a successful run older than this means a missed day. */
export const CRON_FRESH_HOURS = 26

function describeAge(iso: string, now: Date): string {
  const hours = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 3_600_000))
  return hours < 1 ? 'less than an hour ago' : hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/**
 * The scheduled worker (/api/cron/jobs), from the runs it records in cron_runs. Without
 * CRON_SECRET it cannot run at all.
 */
export async function checkCron(deps: HealthDeps): Promise<CheckOutcome> {
  if (!deps.env.CRON_SECRET?.trim()) {
    return {
      state: 'not_configured',
      summary: "Scheduled jobs can't run: CRON_SECRET is not set.",
      details: ['Consent sync, booking confirmations and resumed sends depend on them.'],
      actionHint: 'Set CRON_SECRET in the deployment environment.',
    }
  }

  let runs: LastCronRuns
  try {
    runs = await deps.readLastCronRuns('jobs')
  } catch {
    return { state: 'degraded', summary: 'The record of scheduled runs could not be read.' }
  }

  const now = deps.now()
  const { lastRun, lastSuccess } = runs
  const details = lastRun ? [`Last run ${describeAge(lastRun.finished_at, now)} (${lastRun.status}).`] : []
  if (lastSuccess && lastSuccess.id !== lastRun?.id) details.push(`Last successful run ${describeAge(lastSuccess.finished_at, now)}.`)

  if (!lastRun) {
    return {
      state: 'degraded',
      summary: 'No scheduled run has been recorded yet.',
      actionHint: "Check the hosting platform's cron schedule for /api/cron/jobs.",
    }
  }
  if (lastRun.status === 'failed') {
    return {
      state: 'degraded',
      summary: `The last scheduled run failed, ${describeAge(lastRun.finished_at, now)}.`,
      details,
      actionHint: 'Check the server log for /api/cron/jobs.',
    }
  }
  const ageHours = (now.getTime() - new Date(lastRun.finished_at).getTime()) / 3_600_000
  if (ageHours >= CRON_FRESH_HOURS) {
    return {
      state: 'degraded',
      summary: `The last successful scheduled run was ${describeAge(lastRun.finished_at, now)}.`,
      details,
      actionHint: "Check the hosting platform's cron schedule for /api/cron/jobs.",
    }
  }
  return { state: 'ok', summary: `Running: last successful run ${describeAge(lastRun.finished_at, now)}.`, details }
}

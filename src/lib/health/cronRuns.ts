import type { SupabaseClient } from '@supabase/supabase-js'

import type { CronJob, CronRunRow, CronRunStatus, CronRunTables } from '@/lib/db/cronRunTypes'
import type { Database } from '@/lib/db/types'

/**
 * Recording and reading scheduled job runs (cron_runs). Recording is best effort: a
 * failure to record is logged and never fails the run itself.
 */

/** Just enough of a Database for cron_runs until it is wired into `Database`. */
type CronRunDatabase = {
  public: {
    Tables: CronRunTables
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

function cronRuns(db: SupabaseClient<Database>) {
  return (db as unknown as SupabaseClient<CronRunDatabase>).from('cron_runs')
}

export type CronRunRecord = {
  job: CronJob
  status: CronRunStatus
  startedAt: Date
  summary?: Record<string, number | boolean>
  errorCode?: string | null
}

/** Numbers and booleans only, so no contact data or error text can slip in. */
function countsOnly(summary: Record<string, unknown> = {}): Record<string, number | boolean> {
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
  ) as Record<string, number | boolean>
}

export async function recordCronRun(db: SupabaseClient<Database>, run: CronRunRecord): Promise<void> {
  try {
    const { error } = await cronRuns(db).insert({
      job: run.job,
      status: run.status,
      started_at: run.startedAt.toISOString(),
      summary: countsOnly(run.summary),
      error_code: run.errorCode ?? null,
    })
    if (error) console.error(`Could not record the ${run.job} cron run:`, error.code ?? 'error')
  } catch (error) {
    console.error(`Could not record the ${run.job} cron run:`, error instanceof Error ? error.name : 'unknown error')
  }
}

export type LastCronRuns = { lastRun: CronRunRow | null; lastSuccess: CronRunRow | null }

/** The latest run, and the latest successful run, of one job. */
export async function readLastCronRuns(db: SupabaseClient<Database>, job: CronJob): Promise<LastCronRuns> {
  const latest = (status?: CronRunStatus) => {
    let query = cronRuns(db).select('*').eq('job', job)
    if (status) query = query.eq('status', status)
    return query.order('finished_at', { ascending: false }).limit(1).maybeSingle()
  }
  const [last, success] = await Promise.all([latest(), latest('succeeded')])
  if (last.error) throw new Error('cron_runs unreadable')
  if (success.error) throw new Error('cron_runs unreadable')
  return { lastRun: (last.data as CronRunRow | null) ?? null, lastSuccess: (success.data as CronRunRow | null) ?? null }
}

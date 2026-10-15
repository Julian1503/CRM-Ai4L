/**
 * Database types for scheduled job runs (20261012000000_cron_runs.sql).
 * Wired into `Database` in src/lib/db/types.ts.
 */

export type CronJob = 'jobs' | 'newsletters'
export type CronRunStatus = 'succeeded' | 'failed'

export type CronRunRow = {
  id: string
  job: CronJob
  status: CronRunStatus
  started_at: string
  finished_at: string
  /** Counts only; never contact data. */
  summary: Record<string, number | boolean>
  /** A short snake_case code, never free error text. */
  error_code: string | null
}

type Table<Row, Insert> = { Row: Row; Insert: Insert; Update: Partial<Row>; Relationships: [] }

export type CronRunTables = {
  cron_runs: Table<CronRunRow, Pick<CronRunRow, 'job' | 'status' | 'started_at'> & Partial<CronRunRow>>
}

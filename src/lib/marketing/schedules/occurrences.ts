import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database, NewsletterFrequency, NewsletterScheduleRow } from '@/lib/db/types'
import type {
  NewsletterScheduleOccurrenceRow,
  OccurrenceToRecord,
  RecordOccurrencesResult,
  ScheduleOccurrenceFunctions,
} from '@/lib/db/scheduleOccurrenceTypes'

import { localDate, nextOccurrence } from './nextRun'

/**
 * Durable newsletter occurrences (audit H12) — the TypeScript side of
 * 20261008000000_newsletter_schedule_occurrences.sql.
 *
 * The schedule arithmetic stays here (it needs the tz database); the database records
 * the occurrences and advances `next_run_at` in one transaction, applies the catch-up
 * policy, and owns the leases.
 */

type Db = SupabaseClient<Database>

/** The RPC surface, typed locally until scheduleOccurrenceTypes is wired into Database. */
type OccurrenceRpc = <Name extends keyof ScheduleOccurrenceFunctions>(
  fn: Name,
  args: ScheduleOccurrenceFunctions[Name]['Args']
) => PromiseLike<{
  data: ScheduleOccurrenceFunctions[Name]['Returns'] | null
  error: { message: string; code?: string } | null
}>

function rpc(db: Db): OccurrenceRpc {
  return ((fn: string, args: unknown) => (db.rpc as unknown as (f: string, a: unknown) => unknown)(fn, args)) as OccurrenceRpc
}

/** Matches the database's limit on one record call. */
export const MAX_RECORDED_OCCURRENCES = 200
export const DRAFT_LEASE_SECONDS = 300

export type DueOccurrences = { occurrences: OccurrenceToRecord[]; nextRunAt: Date }

/**
 * Every occurrence due from `nextRunAt` up to `now`, oldest first, and the first one
 * strictly after `now`. A very long outage keeps the first occurrence (the database
 * checks it) and the most recent ones; the gap is not recorded.
 */
export function dueOccurrences(
  nextRunAt: Date,
  frequency: NewsletterFrequency,
  timeZone: string,
  now: Date
): DueOccurrences {
  const due: OccurrenceToRecord[] = []
  let cursor = nextRunAt

  while (cursor.getTime() <= now.getTime()) {
    due.push({ scheduledFor: localDate(cursor, timeZone), dueAt: cursor.toISOString() })
    cursor = nextOccurrence(cursor, frequency, timeZone)
  }

  const occurrences =
    due.length > MAX_RECORDED_OCCURRENCES
      ? [due[0], ...due.slice(due.length - (MAX_RECORDED_OCCURRENCES - 1))]
      : due

  return { occurrences, nextRunAt: cursor }
}

export async function recordDueOccurrences(
  db: Db,
  schedule: Pick<NewsletterScheduleRow, 'id' | 'next_run_at' | 'frequency' | 'timezone'>,
  now: Date
): Promise<RecordOccurrencesResult> {
  const due = dueOccurrences(new Date(schedule.next_run_at), schedule.frequency, schedule.timezone, now)
  if (due.occurrences.length === 0) return { outcome: 'claimed_elsewhere' }

  const { data, error } = await rpc(db)('record_newsletter_occurrences', {
    p_schedule_id: schedule.id,
    p_expected_next_run_at: schedule.next_run_at,
    p_next_run_at: due.nextRunAt.toISOString(),
    p_occurrences: due.occurrences,
  })
  if (error) throw new Error(`Could not record the schedule's occurrences: ${error.message}`)
  if (!data) throw new Error('Recording the occurrences returned nothing.')
  return data
}

export async function claimOccurrences(
  db: Db,
  options: { limit: number; occurrenceId?: string }
): Promise<NewsletterScheduleOccurrenceRow[]> {
  const { data, error } = await rpc(db)('claim_newsletter_occurrences', {
    p_limit: options.limit,
    p_lease_seconds: DRAFT_LEASE_SECONDS,
    p_occurrence_id: options.occurrenceId ?? null,
  })
  if (error) throw new Error(`Could not claim newsletter occurrences: ${error.message}`)
  return data ?? []
}

/** False when the lease was lost (another run took the occurrence over). */
export async function completeOccurrence(
  db: Db,
  occurrence: Pick<NewsletterScheduleOccurrenceRow, 'id' | 'claim_token'>,
  campaignId: string
): Promise<boolean> {
  const { data, error } = await rpc(db)('complete_newsletter_occurrence', {
    p_occurrence_id: occurrence.id,
    p_claim_token: occurrence.claim_token ?? '',
    p_campaign_id: campaignId,
  })
  if (error) throw new Error(`Could not record the drafted occurrence: ${error.message}`)
  return data === true
}

export async function failOccurrence(
  db: Db,
  occurrence: Pick<NewsletterScheduleOccurrenceRow, 'id' | 'claim_token'>,
  message: string,
  retryable: boolean
): Promise<'pending' | 'failed' | 'lost'> {
  const { data, error } = await rpc(db)('fail_newsletter_occurrence', {
    p_occurrence_id: occurrence.id,
    p_claim_token: occurrence.claim_token ?? '',
    p_error: message,
    p_retryable: retryable,
  })
  if (error) throw new Error(`Could not record the failed occurrence: ${error.message}`)
  return data ?? 'lost'
}

export class OccurrenceRetryError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'OccurrenceRetryError'
    this.status = status
  }
}

/** A person puts a failed or skipped occurrence back in the queue (member RPC). */
export async function retryOccurrence(db: Db, occurrenceId: string): Promise<NewsletterScheduleOccurrenceRow> {
  const { data, error } = await rpc(db)('retry_newsletter_occurrence', { p_occurrence_id: occurrenceId })
  if (error?.code === 'P0002') throw new OccurrenceRetryError('Occurrence not found.', 404)
  if (error?.code === 'CRM06') throw new OccurrenceRetryError(error.message, 409)
  if (error) throw new Error(`Could not retry the occurrence: ${error.message}`)
  if (!data) throw new OccurrenceRetryError('Occurrence not found.', 404)
  return data
}

/** Failed and skipped occurrences, newest first, for the schedule list. */
export async function listAttentionOccurrences(db: Db, limit = 100): Promise<NewsletterScheduleOccurrenceRow[]> {
  const { data, error } = await (db as unknown as SupabaseClient)
    .from('newsletter_schedule_occurrences')
    .select('*')
    .in('status', ['failed', 'skipped'])
    .order('scheduled_for', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`Could not read the schedule occurrences: ${error.message}`)
  return (data ?? []) as NewsletterScheduleOccurrenceRow[]
}

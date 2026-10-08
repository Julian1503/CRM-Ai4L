/**
 * Row and RPC types for supabase/migrations/20261008000000_newsletter_schedule_occurrences.sql
 * (audit H12). Hand-written like src/lib/db/types.ts, which composes these into `Database`.
 */

export type ScheduleOccurrenceStatus = 'pending' | 'drafting' | 'drafted' | 'failed' | 'skipped'

export type NewsletterScheduleOccurrenceRow = {
  id: string
  schedule_id: string
  /** Local calendar date (YYYY-MM-DD): the campaign's `scheduled_for`. */
  scheduled_for: string
  due_at: string
  status: ScheduleOccurrenceStatus
  attempts: number
  max_attempts: number
  next_attempt_at: string
  claim_token: string | null
  lease_expires_at: string | null
  last_error: string | null
  skip_reason: string | null
  campaign_id: string | null
  retried_by: string | null
  retried_at: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

/** One element of `p_occurrences`, oldest first. */
export type OccurrenceToRecord = { scheduledFor: string; dueAt: string }

export type RecordOccurrencesResult =
  | { outcome: 'recorded'; pendingId: string | null; skipped: number }
  | { outcome: 'claimed_elsewhere' }
  | { outcome: 'inactive' }

type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] }

export type ScheduleOccurrenceTables = {
  newsletter_schedule_occurrences: Table<NewsletterScheduleOccurrenceRow>
}

export type ScheduleOccurrenceFunctions = {
  record_newsletter_occurrences: {
    Args: {
      p_schedule_id: string
      p_expected_next_run_at: string
      p_next_run_at: string
      p_occurrences: OccurrenceToRecord[]
    }
    Returns: RecordOccurrencesResult
  }
  claim_newsletter_occurrences: {
    Args: { p_limit?: number; p_lease_seconds?: number; p_occurrence_id?: string | null }
    Returns: NewsletterScheduleOccurrenceRow[]
  }
  complete_newsletter_occurrence: {
    Args: { p_occurrence_id: string; p_claim_token: string; p_campaign_id: string }
    Returns: boolean
  }
  fail_newsletter_occurrence: {
    Args: { p_occurrence_id: string; p_claim_token: string; p_error: string; p_retryable: boolean }
    Returns: 'pending' | 'failed' | 'lost'
  }
  retry_newsletter_occurrence: {
    Args: { p_occurrence_id: string }
    Returns: NewsletterScheduleOccurrenceRow
  }
}

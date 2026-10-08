import type { SupabaseClient } from '@supabase/supabase-js'

import { applyCalendlyEvent } from '@/lib/booking/calendly'
import { processNotifications, type NotificationResult, type RetrieveCheckout } from '@/lib/booking/notifications'
import { processConsentOutbox, type ConsentSyncResult } from '@/lib/consent/outbox'
import type { Database } from '@/lib/db/types'
import { advanceCampaignSend } from '@/lib/marketing/dispatch'
import type { EmailOctopusCredentials } from '@/lib/marketing/providers/credentials'

/**
 * The scheduled worker's jobs, run in priority order within a time budget.
 *
 * Everything here is durable work whose state lives in the database, so a run that
 * stops early — the budget, a crash, a deploy — loses nothing; the next run continues.
 * Browsers and inline requests may do the same work sooner; claims make that safe.
 *
 *   1. consent outbox       withdrawals must reach the provider (audit H5)
 *   2. notifications        booking confirmations, retried apart from payment (H10)
 *   3. booking reconciliation  Calendly events that matched nothing yet (M4)
 *   4. sending campaigns    a send no longer depends on a browser tab (audit H3)
 *   5. content job leases   backstop for the Content Studio worker (plan §10)
 */

export type JobsReport = {
  consent: ConsentSyncResult & { batches: number }
  notifications: NotificationResult
  reconciliation: { retried: number; resolved: number }
  campaigns: Array<{ id: string; outcome: string; sent?: number; pending?: number }>
  content: { recovered: number }
  stoppedForBudget: boolean
}

type JobsOptions = {
  db: SupabaseClient<Database>
  credentials: EmailOctopusCredentials | null
  baseUrl: string | null
  preferencesOrigin: string | null
  /** Reads a Stripe checkout for the confirmation email's link; null without Stripe. */
  retrieveCheckout?: RetrieveCheckout | null
  /** Milliseconds this run may spend before returning. */
  budgetMs: number
  now?: () => number
}

const CONSENT_BATCH = 100
const SEND_CHUNK = 200
const MAX_CAMPAIGNS_PER_RUN = 5
const RECONCILIATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const RECONCILIATION_BATCH = 50

export async function runJobs(options: JobsOptions): Promise<JobsReport> {
  const now = options.now ?? Date.now
  const deadline = now() + options.budgetMs
  const report: JobsReport = {
    consent: { claimed: 0, synced: 0, failed: 0, batches: 0 },
    notifications: { claimed: 0, sent: 0, skipped: 0, retried: 0 },
    reconciliation: { retried: 0, resolved: 0 },
    campaigns: [],
    content: { recovered: 0 },
    stoppedForBudget: false,
  }

  // 1. Consent: drain until empty or out of time.
  while (now() < deadline) {
    const batch = await processConsentOutbox(options.db, {
      credentials: options.credentials,
      origin: options.preferencesOrigin,
      limit: CONSENT_BATCH,
    })
    report.consent.batches += 1
    report.consent.claimed += batch.claimed
    report.consent.synced += batch.synced
    report.consent.failed += batch.failed
    if (batch.notConfigured) report.consent.notConfigured = true
    if (batch.claimed < CONSENT_BATCH) break
  }

  // 2. Confirmation emails queued with a payment.
  if (now() < deadline) {
    report.notifications = await processNotifications(options.db, {
      retrieveCheckout: options.retrieveCheckout ?? null,
      limit: 50,
    })
  }

  // 3. Calendly events parked because nothing matched yet (a create that beat its
  //    booking's payment, a contact added later). A week, then they wait for a person.
  if (now() < deadline) {
    const since = new Date(now() - RECONCILIATION_WINDOW_MS).toISOString()
    const { data: parked, error: parkedError } = await options.db
      .from('booking_reconciliation')
      .select('event_type, invitee_uri, event_uri, email, scheduled_at, tracking_booking_id, old_invitee_uri, rescheduled')
      .is('resolved_at', null)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(RECONCILIATION_BATCH)
    if (parkedError) throw new Error(`Could not read parked booking events: ${parkedError.message}`)

    for (const row of parked ?? []) {
      if (now() >= deadline) break
      const outcome = await applyCalendlyEvent(options.db, {
        event: row.event_type as 'invitee.created' | 'invitee.canceled',
        inviteeUri: row.invitee_uri,
        eventUri: row.event_uri,
        scheduledAt: row.scheduled_at,
        email: row.email,
        trackingBookingId: row.tracking_booking_id,
        // A parked reschedule cancel must replay as a reschedule, not as a cancellation.
        rescheduled: row.rescheduled === true,
        oldInviteeUri: row.old_invitee_uri,
      })
      report.reconciliation.retried += 1
      if (outcome === 'applied') report.reconciliation.resolved += 1
    }
  }

  // 4. Campaigns left sending — a closed tab, a crash, or a deploy mid-send.
  // Without an app origin, only Studio campaigns are attempted: a hand-written campaign
  // always books, and dispatch refuses a booking campaign without an origin anyway.
  if (options.credentials) {
    const { data, error } = await options.db
      .from('campaigns')
      .select('id, content_snapshot_id')
      .eq('status', 'sending')
      .order('started_at', { ascending: true, nullsFirst: true })
      .limit(MAX_CAMPAIGNS_PER_RUN)
    if (error) throw new Error(`Could not list sending campaigns: ${error.message}`)

    for (const { id, content_snapshot_id: snapshotId } of data ?? []) {
      if (!options.baseUrl && !snapshotId) continue
      let hasMore = true
      while (hasMore && now() < deadline) {
        const outcome = await advanceCampaignSend(options.db, id, {
          credentials: options.credentials,
          baseUrl: options.baseUrl,
          chunkSize: SEND_CHUNK,
        })

        if (outcome.kind !== 'progress') {
          report.campaigns.push({ id, outcome: outcome.kind })
          break
        }

        // A chunk that claimed nothing is waiting on leases or reconciliation; stop.
        hasMore = outcome.summary.pending > 0 && outcome.progress.total > 0
        if (!hasMore || now() >= deadline) {
          report.campaigns.push({ id, outcome: outcome.status, sent: outcome.summary.sent, pending: outcome.summary.pending })
        }
      }
    }
  }

  // 5. Content Studio leases. One bounded call per run: an expired lease goes back to the
  //    queue before begin-dispatch and becomes 'uncertain' after it. The engine does this on
  //    every claim; this is the backstop while the engine is down, so Operations still sees
  //    stuck publications. Generation itself never runs here.
  if (now() < deadline) {
    const { data, error } = await options.db.rpc('recover_content_jobs')
    if (error) throw new Error(`Could not recover content jobs: ${error.message}`)
    report.content = { recovered: typeof data === 'number' ? data : 0 }
  }

  report.stoppedForBudget = now() >= deadline
  return report
}

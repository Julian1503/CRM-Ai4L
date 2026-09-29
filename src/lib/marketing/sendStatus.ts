import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * What the send ledger says about a campaign's current run.
 *
 * Read back rather than inferred from the chunk that just ran: a send is chunked and
 * resumable, so the run that finishes a campaign is rarely the run that failed part of
 * it. Every ledger status is counted separately (audit H3/H4) — a recipient skipped for
 * withdrawn consent or left uncertain after a provider timeout is neither sent nor
 * forgotten.
 *
 * Served by one SQL aggregate for many campaigns at once (campaign_send_summaries), so
 * a page of campaigns costs one request, not one per row (audit A2).
 */
export type CampaignSendSummary = {
  /** Which fan-out these figures describe. A re-sent campaign has more than one. */
  run: number
  total: number
  /** Accepted by the provider. Not the same as delivered. */
  sent: number
  failed: number
  /** Still to go: queued plus currently claimed by a worker. */
  pending: number
  /** Claimed by a worker right now. Included in `pending`. */
  processing: number
  /** Not sent because the contact was no longer eligible at dispatch. */
  skipped: number
  /** The provider may or may not have queued these. Need reconciliation; never retried automatically. */
  uncertain: number
  /** The provider's own words for the most recent failure, or null if none failed. */
  failureReason: string | null
  /** Why recipients are waiting or uncertain, or null when nothing is recorded. */
  stallReason: string | null
}

export const MAX_SUMMARY_BATCH = 200

type SummaryRow = {
  campaign_id: string
  run: number
  pending: number
  processing: number
  sent: number
  failed: number
  skipped: number
  uncertain: number
  failure_reason: string | null
  stall_reason: string | null
}

function toSummary(row: SummaryRow): CampaignSendSummary {
  const pending = row.pending + row.processing

  return {
    run: row.run,
    total: pending + row.sent + row.failed + row.skipped + row.uncertain,
    sent: row.sent,
    failed: row.failed,
    pending,
    processing: row.processing,
    skipped: row.skipped,
    uncertain: row.uncertain,
    failureReason: row.failed > 0 ? row.failure_reason : null,
    stallReason: pending + row.uncertain > 0 ? row.stall_reason : null,
  }
}

/** Current-run summaries for up to MAX_SUMMARY_BATCH campaigns, keyed by campaign id. */
export async function readCampaignSendSummaries(
  db: SupabaseClient<Database>,
  campaignIds: readonly string[]
): Promise<Map<string, CampaignSendSummary>> {
  const ids = [...new Set(campaignIds)]
  if (ids.length === 0) return new Map()
  if (ids.length > MAX_SUMMARY_BATCH) {
    throw new Error(`At most ${MAX_SUMMARY_BATCH} campaign summaries can be read at once.`)
  }

  const rpc = db.rpc.bind(db) as unknown as (
    fn: 'campaign_send_summaries',
    args: { p_campaign_ids: string[] }
  ) => PromiseLike<{ data: SummaryRow[] | null; error: { message: string } | null }>

  const { data, error } = await rpc('campaign_send_summaries', { p_campaign_ids: ids })
  if (error) throw new Error(`Could not read send summaries: ${error.message}`)

  return new Map((data ?? []).map((row) => [row.campaign_id, toSummary(row)]))
}

export async function readCampaignSendSummary(
  db: SupabaseClient<Database>,
  campaignId: string
): Promise<CampaignSendSummary> {
  const summary = (await readCampaignSendSummaries(db, [campaignId])).get(campaignId)
  if (!summary) throw new Error('Campaign not found.')

  return summary
}

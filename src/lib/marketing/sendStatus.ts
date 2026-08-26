import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignSendRow, Database } from '@/lib/db/types'

/** The ledger statuses this report counts. Mirrors the table's CHECK constraint. */
type LedgerStatus = CampaignSendRow['status']

/**
 * What the send ledger says about one campaign.
 *
 * Read back rather than inferred from the chunk that just ran: a send is chunked and
 * resumable, so the run that finishes a campaign is rarely the run that failed part of
 * it. Without the cumulative view, a campaign could end `failed` while the last chunk
 * reported nothing but successes — which is exactly how a whole failed send used to
 * reach the operator as a silent status change.
 */
export type CampaignSendSummary = {
  total: number
  sent: number
  failed: number
  pending: number
  /** The provider's own words for the most recent failure, or null if none failed. */
  failureReason: string | null
  /**
   * Why recipients are still waiting — a rate limit or an outage recorded against a
   * pending row. Null when the remaining work simply has not been attempted yet.
   */
  stallReason: string | null
}

async function countByStatus(
  db: SupabaseClient<Database>,
  campaignId: string,
  status: LedgerStatus
): Promise<number> {
  const { count, error } = await db
    .from('campaign_sends')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', status)

  if (error) throw new Error(error.message)

  return count ?? 0
}

/** The most recent non-empty `error` recorded against a row in this status. */
async function latestReason(
  db: SupabaseClient<Database>,
  campaignId: string,
  status: LedgerStatus
): Promise<string | null> {
  const { data, error } = await db
    .from('campaign_sends')
    .select('error')
    .eq('campaign_id', campaignId)
    .eq('status', status)
    .not('error', 'is', null)
    .order('attempted_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(error.message)

  const reason = (data as { error?: string | null } | null)?.error

  return typeof reason === 'string' && reason.trim() !== '' ? reason : null
}

/**
 * Reads the ledger totals, plus the reason behind them when there is one.
 *
 * The two reason lookups are skipped when their counts are zero, so a clean send costs
 * three head-count queries and nothing more.
 */
export async function readCampaignSendSummary(
  db: SupabaseClient<Database>,
  campaignId: string
): Promise<CampaignSendSummary> {
  const pending = await countByStatus(db, campaignId, 'pending')
  const failed = await countByStatus(db, campaignId, 'failed')
  const sent = await countByStatus(db, campaignId, 'sent')

  const failureReason = failed > 0 ? await latestReason(db, campaignId, 'failed') : null
  const stallReason = pending > 0 ? await latestReason(db, campaignId, 'pending') : null

  return {
    total: pending + failed + sent,
    sent,
    failed,
    pending,
    failureReason,
    stallReason,
  }
}

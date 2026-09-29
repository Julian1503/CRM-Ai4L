import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * Work that has stopped moving on its own and needs a person (plan section 13,
 * "Operational visibility"). Each count is a head-only query, so no rows or personal
 * data leave the database.
 */
export type AttentionCounts = {
  /** Provider outcome unknown; reconcile from the campaign's send report. */
  uncertainSends: number
  /** Claimed by a worker whose lease ran out. Recovered on the next claim. */
  expiredSendClaims: number
  /** Consent changes not yet at the provider. */
  consentSyncPending: number
  /** Consent changes that gave up after repeated provider failures. */
  consentSyncFailed: number
}

type HeadQuery = PromiseLike<{ count: number | null; error: { message: string } | null }>

async function count(query: HeadQuery): Promise<number> {
  const { count: total, error } = await query
  if (error) throw new Error(error.message)
  return total ?? 0
}

export async function readAttentionCounts(db: SupabaseClient<Database>): Promise<AttentionCounts> {
  const now = new Date().toISOString()
  const head = { count: 'exact' as const, head: true }

  const [uncertainSends, expiredSendClaims, consentSyncPending, consentSyncFailed] = await Promise.all([
    count(db.from('campaign_sends').select('id', head).eq('status', 'uncertain')),
    count(db.from('campaign_sends').select('id', head).eq('status', 'processing').lt('lease_expires_at', now)),
    count(db.from('consent_sync_outbox').select('id', head).in('status', ['pending', 'processing'])),
    count(db.from('consent_sync_outbox').select('id', head).eq('status', 'failed')),
  ])

  return { uncertainSends, expiredSendClaims, consentSyncPending, consentSyncFailed }
}

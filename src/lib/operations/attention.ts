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
  /** Content jobs whose worker lease ran out. Recovered (or made uncertain) on the next claim. */
  contentJobsStale: number
  /** Content jobs that failed in the last 7 days. */
  contentJobsFailed: number
  /** Content jobs whose external effect may or may not have happened; a person must resolve them. */
  contentJobsUncertain: number
  /** Social accounts that need to be reconnected before anything can be published. */
  socialAccountsUnhealthy: number
  /** Social posts whose outcome is unknown; check the network, then resolve the job. */
  socialPublicationsUncertain: number
}

/** Failed content jobs are shown for this long; older failures are history, not work. */
export const CONTENT_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

type HeadQuery = PromiseLike<{ count: number | null; error: { message: string } | null }>

async function count(query: HeadQuery): Promise<number> {
  const { count: total, error } = await query
  if (error) throw new Error(error.message)
  return total ?? 0
}

const HEAD = { count: 'exact' as const, head: true }

type ContentCounts = Pick<
  AttentionCounts,
  'contentJobsStale' | 'contentJobsFailed' | 'contentJobsUncertain' | 'socialAccountsUnhealthy' | 'socialPublicationsUncertain'
>

async function readContentCounts(db: SupabaseClient<Database>, nowMs: number): Promise<ContentCounts> {
  const now = new Date(nowMs).toISOString()
  const since = new Date(nowMs - CONTENT_FAILURE_WINDOW_MS).toISOString()

  const [contentJobsStale, contentJobsFailed, contentJobsUncertain, socialAccountsUnhealthy, socialPublicationsUncertain] =
    await Promise.all([
      count(db.from('content_jobs').select('id', HEAD).eq('status', 'running').lt('lease_expires_at', now)),
      count(db.from('content_jobs').select('id', HEAD).eq('status', 'failed').gte('finished_at', since)),
      count(db.from('content_jobs').select('id', HEAD).eq('status', 'uncertain')),
      count(db.from('social_accounts').select('id', HEAD).eq('status', 'needs_reauth')),
      count(db.from('social_publications').select('id', HEAD).eq('status', 'uncertain')),
    ])

  return { contentJobsStale, contentJobsFailed, contentJobsUncertain, socialAccountsUnhealthy, socialPublicationsUncertain }
}

export async function readAttentionCounts(db: SupabaseClient<Database>, nowMs: number = Date.now()): Promise<AttentionCounts> {
  const now = new Date(nowMs).toISOString()

  const [uncertainSends, expiredSendClaims, consentSyncPending, consentSyncFailed, content] = await Promise.all([
    count(db.from('campaign_sends').select('id', HEAD).eq('status', 'uncertain')),
    count(db.from('campaign_sends').select('id', HEAD).eq('status', 'processing').lt('lease_expires_at', now)),
    count(db.from('consent_sync_outbox').select('id', HEAD).in('status', ['pending', 'processing'])),
    count(db.from('consent_sync_outbox').select('id', HEAD).eq('status', 'failed')),
    readContentCounts(db, nowMs),
  ])

  return { uncertainSends, expiredSendClaims, consentSyncPending, consentSyncFailed, ...content }
}

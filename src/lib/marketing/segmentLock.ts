import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignStatus, Database } from '@/lib/db/types'

/**
 * A segment used by an approved or sending campaign cannot change.
 *
 * The send resolves its audience when it runs, so editing the criteria or the manual
 * overrides after approval would send to people nobody approved. The database enforces
 * this with a trigger (20260929000000_segment_control.sql); this module lets the API
 * say which campaign is in the way before trying, and recognise the trigger's refusal
 * when a race gets there first.
 */

export const LOCKING_STATUSES: CampaignStatus[] = ['approved', 'sending']

export type LockingCampaign = { id: string; name: string; status: CampaignStatus }

export async function findLockingCampaigns(
  db: SupabaseClient<Database>,
  segmentId: string
): Promise<LockingCampaign[]> {
  const { data, error } = await db
    .from('campaigns')
    .select('id, name, status')
    .eq('segment_id', segmentId)
    .in('status', LOCKING_STATUSES)
    .limit(10)

  if (error) throw new Error(`Could not check whether the segment is in use: ${error.message}`)

  return (data ?? []) as LockingCampaign[]
}

export function describeLock(campaigns: readonly LockingCampaign[]): string {
  const names = campaigns.map((campaign) => `"${campaign.name}"`).join(', ')

  return `This segment is used by ${names}, which is approved or sending. Move it back to draft to change who is in the segment.`
}

/** True for the database trigger's refusal, so a race still answers 409, not 500. */
export function isSegmentLockError(error: { message?: string } | null | undefined): boolean {
  return Boolean(error?.message?.includes('Segment is locked'))
}

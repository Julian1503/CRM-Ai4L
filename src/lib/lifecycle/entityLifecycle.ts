import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignStatus, Database } from '@/lib/db/types'

import type { Lifecycle, LifecycleState } from './lifecycle'

/**
 * Per-entity archive/remove rules.
 *
 * Mirrors the triggers in 20260930000000_archive_and_remove.sql, which are the actual
 * guarantee. This copy lets the API name what is in the way before trying, and lets the
 * UI disable an action with its reason instead of discovering it through an error.
 *
 * Removing never loses data, so the rules for archive and remove are the same: only
 * something that is in flight is blocked.
 */

const REMOVED: Lifecycle = { canArchive: false, canRestore: false, canRemove: false, reason: 'This was removed.' }

const ARCHIVED: Lifecycle = { canArchive: false, canRestore: true, canRemove: true, reason: null }

export type SegmentUser = { kind: 'campaign' | 'schedule'; name: string }

const USER_LIMIT = 10

export function segmentLifecycle(state: LifecycleState, users: readonly SegmentUser[]): Lifecycle {
  if (state.removed_at) return REMOVED
  if (state.archived_at) return ARCHIVED

  if (users.length > 0) {
    const names = users
      .map((user) => `${user.kind === 'campaign' ? 'campaign' : 'newsletter schedule'} "${user.name}"`)
      .join(', ')

    return {
      canArchive: false,
      canRestore: false,
      canRemove: false,
      reason: `This segment is used by ${names}. Archive those first.`,
    }
  }

  return { canArchive: true, canRestore: false, canRemove: true, reason: null }
}

/**
 * What would resolve the segment again: a live campaign that has not finished, or a live
 * schedule, paused or not. A sent campaign does not count — re-opening it is refused
 * while its segment is archived.
 */
export async function findSegmentUsers(
  db: SupabaseClient<Database>,
  segmentId: string
): Promise<SegmentUser[]> {
  const [campaigns, schedules] = await Promise.all([
    db
      .from('campaigns')
      .select('name')
      .eq('segment_id', segmentId)
      .is('archived_at', null)
      .neq('status', 'sent')
      .limit(USER_LIMIT),
    db
      .from('newsletter_schedules')
      .select('name')
      .eq('segment_id', segmentId)
      .is('archived_at', null)
      .limit(USER_LIMIT),
  ])

  const error = campaigns.error ?? schedules.error
  if (error) throw new Error(`Could not check whether the segment is in use: ${error.message}`)

  return [
    ...(campaigns.data ?? []).map((row) => ({ kind: 'campaign' as const, name: row.name })),
    ...(schedules.data ?? []).map((row) => ({ kind: 'schedule' as const, name: row.name })),
  ]
}

const IN_FLIGHT: CampaignStatus[] = ['approved', 'sending']

export function campaignLifecycle(state: LifecycleState & { status: CampaignStatus }): Lifecycle {
  if (state.removed_at) return REMOVED
  if (state.archived_at) return ARCHIVED

  if (IN_FLIGHT.includes(state.status)) {
    return {
      canArchive: false,
      canRestore: false,
      canRemove: false,
      reason: `This campaign is ${state.status}. Move it back to draft, or let it finish, first.`,
    }
  }

  return { canArchive: true, canRestore: false, canRemove: true, reason: null }
}

/** A contact's archive is `deleted_at`; otherwise the same states as everything else. */
export function contactLifecycle(state: { deleted_at: string | null; removed_at: string | null }): Lifecycle {
  if (state.removed_at) return REMOVED
  if (state.deleted_at) return ARCHIVED

  // Nothing about a contact is in flight: its sends, bookings and consent history stay
  // where they are, and segments simply stop resolving it.
  return { canArchive: true, canRestore: false, canRemove: true, reason: null }
}

/** A schedule only drafts; archiving it just stops the next run. */
export function scheduleLifecycle(state: LifecycleState): Lifecycle {
  if (state.removed_at) return REMOVED
  if (state.archived_at) return ARCHIVED

  return { canArchive: true, canRestore: false, canRemove: true, reason: null }
}

/**
 * A template is in use while a live schedule drafts with it. Campaigns do not count:
 * they copied the automation id when they were created.
 */
export function templateLifecycle(state: LifecycleState, schedules: readonly string[]): Lifecycle {
  if (state.removed_at) return REMOVED
  if (state.archived_at) return ARCHIVED

  if (schedules.length > 0) {
    const names = schedules.map((name) => `"${name}"`).join(', ')

    return {
      canArchive: false,
      canRestore: false,
      canRemove: false,
      reason: `This template is used by newsletter schedule ${names}. Archive that first.`,
    }
  }

  return { canArchive: true, canRestore: false, canRemove: true, reason: null }
}

export async function findTemplateUsers(
  db: SupabaseClient<Database>,
  templateId: string
): Promise<string[]> {
  const { data, error } = await db
    .from('newsletter_schedules')
    .select('name')
    .eq('template_id', templateId)
    .is('archived_at', null)
    .limit(USER_LIMIT)

  if (error) throw new Error(`Could not check whether the template is in use: ${error.message}`)

  return (data ?? []).map((row) => row.name)
}

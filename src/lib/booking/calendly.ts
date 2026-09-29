import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * Calendly invitee events, applied order-tolerantly (audit M4).
 *
 * A reschedule arrives as `invitee.canceled` for the old invitee (with
 * `rescheduled: true` and `new_invitee`) plus `invitee.created` for the new one (with
 * `old_invitee`), in either order and possibly twice. The rules live in
 * apply_calendly_event() so they run in one transaction with the webhook's completion:
 *
 *   - a reschedule's cancel retires the old invitee; the booking stays booked
 *   - a retired invitee's late cancel or create is ignored, so it cannot touch the
 *     replacement
 *   - the tracking booking id is trusted only when the invitee's email matches the
 *     booking's contact (it travels through a URL anyone can edit)
 *   - anything unplaceable is parked in booking_reconciliation and retried
 */

export type CalendlyInviteeEvent = {
  event: 'invitee.created' | 'invitee.canceled'
  inviteeUri: string
  eventUri: string | null
  scheduledAt: string | null
  email: string | null
  trackingBookingId: string | null
  rescheduled: boolean
  oldInviteeUri: string | null
}

export type CalendlyOutcome = 'applied' | 'ignored' | 'unmatched'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Reads the fields that matter from a Calendly invitee payload, or null if unusable. */
export function readCalendlyEvent(
  event: 'invitee.created' | 'invitee.canceled',
  payload: Record<string, unknown> | undefined
): CalendlyInviteeEvent | null {
  const inviteeUri = str(payload?.uri)
  if (!inviteeUri) return null

  const scheduled = (payload?.scheduled_event ?? {}) as Record<string, unknown>
  const tracking = (payload?.tracking ?? {}) as Record<string, unknown>
  // Calendly surfaces `?utm_content=` under `tracking`; the booking page sets it.
  const tracked = str(tracking.utm_content)

  return {
    event,
    inviteeUri,
    eventUri: str(scheduled.uri),
    scheduledAt: str(scheduled.start_time),
    email: str(payload?.email),
    trackingBookingId: tracked && UUID.test(tracked) ? tracked : null,
    rescheduled: payload?.rescheduled === true,
    oldInviteeUri: str(payload?.old_invitee),
  }
}

export async function applyCalendlyEvent(
  db: SupabaseClient<Database>,
  invitee: CalendlyInviteeEvent,
  webhook?: { provider: string; eventId: string; token: string }
): Promise<CalendlyOutcome> {
  const rpc = db.rpc.bind(db) as unknown as (
    fn: 'apply_calendly_event',
    args: Record<string, unknown>
  ) => PromiseLike<{ data: CalendlyOutcome | null; error: { message: string } | null }>

  const { data, error } = await rpc('apply_calendly_event', {
    p_event: invitee.event,
    p_invitee_uri: invitee.inviteeUri,
    p_event_uri: invitee.eventUri,
    p_scheduled_at: invitee.scheduledAt,
    p_email: invitee.email,
    p_tracking_booking: invitee.trackingBookingId,
    p_rescheduled: invitee.rescheduled,
    p_old_invitee_uri: invitee.oldInviteeUri,
    p_provider: webhook?.provider ?? null,
    p_event_id: webhook?.eventId ?? null,
    p_event_token: webhook?.token ?? null,
  })

  if (error) throw new Error(`Could not apply the Calendly event: ${error.message}`)
  if (!data) throw new Error('Could not apply the Calendly event: no outcome returned.')

  return data
}

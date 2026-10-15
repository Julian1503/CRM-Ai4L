import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { escapeLikePattern, quoteFilterValue } from '@/lib/contacts/query'
import type { Database } from '@/lib/db/types'

import {
  type FlaggedBookings,
  type NeedsActionCutoffs,
  type NeedsActionReason,
  MAX_FLAGGED_IDS,
  needsActionCutoffs,
  needsActionOrExpression,
  needsActionReasons,
  safeIds,
} from './needsAction'
import type { BookingFilters } from './query'
import { type BookingListRow, fetchBookings } from './repository'
import {
  type BookingDetail,
  type BookingDetailRecord,
  type OutboxRecord,
  type ReconciliationRecord,
  buildBookingTimeline,
} from './timeline'

/**
 * Read side of the bookings work queue (UX plan P4.1–P4.2).
 *
 * Runs on the session client, so every read is subject to RLS: bookings,
 * notification_outbox, booking_reconciliation and webhook_events all grant SELECT to
 * approved CRM members only. Nothing here writes.
 *
 * notification_outbox and the newer webhook_events columns are not in the generated
 * Database type, so those reads go through an untyped view of the same client.
 */

type Db = SupabaseClient<Database>

function untyped(db: Db): SupabaseClient {
  return db as unknown as SupabaseClient
}

/** Words of a name/email search, each of which must match a name or the email. */
const MAX_SEARCH_WORDS = 4
const MAX_SEARCH_CONTACTS = 200

/** Contacts whose name or email matches every word of the term. */
export async function resolveSearchContacts(db: Db, term: string): Promise<string[]> {
  const words = term.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS)
  let query = db.from('contacts').select('id')
  for (const word of words) {
    const pattern = quoteFilterValue(`%${escapeLikePattern(word)}%`)
    query = query.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`)
  }
  const { data, error } = await query.limit(MAX_SEARCH_CONTACTS)
  if (error) throw new Error(`Could not search contacts: ${error.message}`)
  return (data ?? []).map((row) => (row as { id: string }).id)
}

/** Bookings that another table says need a person: unmatched Calendly events, failed emails. */
export async function resolveFlaggedBookings(db: Db): Promise<FlaggedBookings> {
  const raw = untyped(db)
  const [outbox, parked] = await Promise.all([
    raw.from('notification_outbox').select('booking_id').eq('status', 'failed').not('booking_id', 'is', null).limit(MAX_FLAGGED_IDS),
    raw.from('booking_reconciliation').select('tracking_booking_id, email').is('resolved_at', null).limit(MAX_FLAGGED_IDS),
  ])
  if (outbox.error) throw new Error(`Could not read notifications: ${outbox.error.message}`)
  if (parked.error) throw new Error(`Could not read Calendly reconciliation: ${parked.error.message}`)

  const parkedRows = (parked.data ?? []) as { tracking_booking_id: string | null; email: string | null }[]
  const unmatched = new Set(parkedRows.map((row) => row.tracking_booking_id).filter((id): id is string => Boolean(id)))

  // Rows Calendly could not tie to a booking id are matched by the invitee's email, to
  // bookings of that contact still waiting for a time or already scheduled.
  const emails = Array.from(new Set(parkedRows.filter((row) => !row.tracking_booking_id && row.email).map((row) => row.email as string)))
  if (emails.length > 0) {
    const contacts = await db.from('contacts').select('id').in('email', emails).limit(MAX_FLAGGED_IDS)
    if (contacts.error) throw new Error(`Could not match Calendly emails: ${contacts.error.message}`)
    const contactIds = (contacts.data ?? []).map((row) => (row as { id: string }).id)
    if (contactIds.length > 0) {
      const bookings = await db.from('bookings').select('id').in('contact_id', contactIds).in('status', ['paid', 'booked']).limit(MAX_FLAGGED_IDS)
      if (bookings.error) throw new Error(`Could not match Calendly emails: ${bookings.error.message}`)
      for (const row of bookings.data ?? []) unmatched.add((row as { id: string }).id)
    }
  }

  const emailFailed = new Set(((outbox.data ?? []) as { booking_id: string }[]).map((row) => row.booking_id))
  return { unmatchedCalendly: unmatched, emailFailed }
}

function flaggedIds(flagged: FlaggedBookings): string[] {
  return safeIds([...flagged.unmatchedCalendly, ...flagged.emailFailed])
}

export type QueueRow = BookingListRow & { reasons: NeedsActionReason[] }

export type BookingQueuePage = {
  rows: QueueRow[]
  total: number
  needsActionCount: number
}

async function countNeedsAction(db: Db, cutoffs: NeedsActionCutoffs, flagged: FlaggedBookings): Promise<number> {
  const { count, error } = await db
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .or(needsActionOrExpression(cutoffs, flaggedIds(flagged)))
  if (error) throw new Error(`Could not count bookings that need action: ${error.message}`)
  return count ?? 0
}

/** One page of the list (the queue or everything), each row with its reasons. */
export async function fetchBookingQueue(db: Db, filters: BookingFilters, nowMs: number): Promise<BookingQueuePage> {
  const cutoffs = needsActionCutoffs(nowMs)
  const [flagged, contactIds] = await Promise.all([
    resolveFlaggedBookings(db),
    filters.search ? resolveSearchContacts(db, filters.search) : Promise.resolve(undefined),
  ])

  const [{ rows, total }, needsActionCount] = await Promise.all([
    fetchBookings(db, filters, {
      contactIds,
      needsActionExpression: filters.queue === 'needs_action' ? needsActionOrExpression(cutoffs, flaggedIds(flagged)) : undefined,
    }),
    countNeedsAction(db, cutoffs, flagged),
  ])

  return {
    rows: rows.map((row) => ({ ...row, reasons: needsActionReasons(row, cutoffs, flagged) })),
    total,
    needsActionCount,
  }
}

export type SchedulingHealth = {
  /** True when Calendly updates may not be reaching the CRM. */
  delayed: boolean
  /** Calendly events waiting to be matched to a booking. */
  unmatchedEvents: number
  /** Calendly webhook deliveries that failed in the last day. */
  failedDeliveries: number
}

const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000

/** Whether scheduling updates are flowing, for the list's banner. Never throws: it is advisory. */
export async function readSchedulingHealth(db: Db, nowMs: number): Promise<SchedulingHealth | null> {
  try {
    const raw = untyped(db)
    const [parked, failed] = await Promise.all([
      raw.from('booking_reconciliation').select('id', { count: 'exact', head: true }).is('resolved_at', null),
      raw
        .from('webhook_events')
        .select('id', { count: 'exact', head: true })
        .eq('provider', 'calendly')
        .in('status', ['failed_retryable', 'failed_terminal'])
        .gte('received_at', new Date(nowMs - HEALTH_WINDOW_MS).toISOString()),
    ])
    if (parked.error || failed.error) return null
    const unmatchedEvents = parked.count ?? 0
    const failedDeliveries = failed.count ?? 0
    return { delayed: unmatchedEvents + failedDeliveries > 0, unmatchedEvents, failedDeliveries }
  } catch {
    return null
  }
}

const DETAIL_COLUMNS =
  'id, status, created_at, updated_at, expires_at, consumed_at, stripe_session_id, calendly_event_uri, ' +
  'calendly_invitee_uri, calendly_superseded_invitees, scheduled_at, cancelled_at, list_amount_cents, ' +
  'charged_amount_cents, currency, contact:contacts(id, first_name, last_name, email), campaign:campaigns(id, name)'

const MAX_TIMELINE_ROWS = 20

/** One booking with its timeline and the reasons it needs action, or null if not visible. */
export async function fetchBookingDetail(db: Db, id: string, nowMs: number): Promise<BookingDetail | null> {
  const raw = untyped(db)
  const { data, error } = await raw.from('bookings').select(DETAIL_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw new Error(`Could not load booking: ${error.message}`)
  if (!data) return null
  const booking = data as unknown as BookingDetailRecord

  const reconciliationFilter = booking.contact?.email
    ? `tracking_booking_id.eq.${id},email.eq.${quoteFilterValue(booking.contact.email)}`
    : `tracking_booking_id.eq.${id}`

  const [outbox, parked, flagged] = await Promise.all([
    raw
      .from('notification_outbox')
      .select('id, kind, status, attempts, last_error, created_at, sent_at')
      .eq('booking_id', id)
      .order('created_at', { ascending: true })
      .limit(MAX_TIMELINE_ROWS),
    raw
      .from('booking_reconciliation')
      .select('id, event_type, reason, scheduled_at, created_at, resolved_at, resolution')
      .or(reconciliationFilter)
      .order('created_at', { ascending: true })
      .limit(MAX_TIMELINE_ROWS),
    resolveFlaggedBookings(db),
  ])
  if (outbox.error) throw new Error(`Could not read notifications: ${outbox.error.message}`)
  if (parked.error) throw new Error(`Could not read Calendly reconciliation: ${parked.error.message}`)

  const outboxRows = (outbox.data ?? []) as OutboxRecord[]
  const parkedRows = (parked.data ?? []) as ReconciliationRecord[]

  return {
    booking,
    reasons: needsActionReasons(booking, needsActionCutoffs(nowMs), flagged),
    timeline: buildBookingTimeline(booking, outboxRows, parkedRows, nowMs),
  }
}

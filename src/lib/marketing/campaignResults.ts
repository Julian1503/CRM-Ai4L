import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignStatus, ConsentStream, Database } from '@/lib/db/types'
import type { PageParams } from '@/lib/pagination'
import { getPageRange } from '@/lib/pagination'

import { MAX_SUMMARY_BATCH, readCampaignSendSummaries, type CampaignSendSummary } from './sendStatus'

/**
 * What happened after the email, per campaign, from the booking each recipient's link
 * carries. Counted per contact, at the furthest stage each one reached, across every
 * send of the campaign (20261029000000_campaign_booking_funnel.sql).
 */
export type CampaignBookingFunnel = {
  /** Opened checkout from the email's link. Being emailed (a pending booking) is not enough. */
  started: number
  /** Paid, or claimed the consultation at $0 — including those now booked or since cancelled. */
  paid: number
  /** Have a time in the calendar. */
  booked: number
  /** Cancelled and hold nothing live. */
  cancelled: number
  /** Taken at checkout. Refunds are made in Stripe and not reflected here. */
  chargedCents: number
  lastBookingAt: string | null
}

export type CampaignResult = {
  id: string
  name: string
  status: CampaignStatus
  consentStream: ConsentStream
  segmentName: string | null
  startedAt: string | null
  completedAt: string | null
  /** Which send this is; above 1 when a sent campaign was sent again. */
  run: number
  send: CampaignSendSummary | null
  funnel: CampaignBookingFunnel
}

/** Campaigns that have gone out, or tried to: the ones with results to show. */
export const RESULT_STATUSES: readonly CampaignStatus[] = ['sending', 'sent', 'failed']

const EMPTY_FUNNEL: CampaignBookingFunnel = {
  started: 0,
  paid: 0,
  booked: 0,
  cancelled: 0,
  chargedCents: 0,
  lastBookingAt: null,
}

type FunnelRow = Database['public']['Functions']['campaign_booking_funnel']['Returns'][number]

/** Booking funnels for up to MAX_SUMMARY_BATCH campaigns, keyed by campaign id. */
export async function readCampaignBookingFunnels(
  db: SupabaseClient<Database>,
  campaignIds: readonly string[]
): Promise<Map<string, CampaignBookingFunnel>> {
  const ids = [...new Set(campaignIds)]
  if (ids.length === 0) return new Map()
  if (ids.length > MAX_SUMMARY_BATCH) {
    throw new Error(`At most ${MAX_SUMMARY_BATCH} campaign results can be read at once.`)
  }

  const rpc = db.rpc.bind(db) as unknown as (
    fn: 'campaign_booking_funnel',
    args: { p_campaign_ids: string[] }
  ) => PromiseLike<{ data: FunnelRow[] | null; error: { message: string } | null }>

  const { data, error } = await rpc('campaign_booking_funnel', { p_campaign_ids: ids })
  if (error) throw new Error(`Could not read campaign bookings: ${error.message}`)

  return new Map(
    (data ?? []).map((row) => [
      row.campaign_id,
      {
        started: row.started,
        paid: row.paid,
        booked: row.booked,
        cancelled: row.cancelled,
        // bigint arrives as a number or a numeric string depending on size.
        chargedCents: Number(row.charged_cents) || 0,
        lastBookingAt: row.last_booking_at,
      },
    ])
  )
}

/**
 * One page of sent (or sending, or failed) campaigns with their send ledger and
 * booking funnel: three reads whatever the page size.
 */
export async function readCampaignResults(
  db: SupabaseClient<Database>,
  page: PageParams
): Promise<{ results: CampaignResult[]; total: number }> {
  const { from, to } = getPageRange(page)

  const { data, error, count } = await db
    .from('campaigns')
    .select('id, name, status, consent_stream, started_at, completed_at, send_run, created_at, segment:segments(name)', {
      count: 'exact',
    })
    .is('archived_at', null)
    .in('status', [...RESULT_STATUSES])
    .order('started_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) throw new Error(`Could not load campaign results: ${error.message}`)

  const rows = (data ?? []) as unknown as Array<{
    id: string
    name: string
    status: CampaignStatus
    consent_stream: ConsentStream
    started_at: string | null
    completed_at: string | null
    send_run: number
    segment: { name: string } | null
  }>
  const ids = rows.map((row) => row.id)

  const [summaries, funnels] = await Promise.all([
    readCampaignSendSummaries(db, ids),
    readCampaignBookingFunnels(db, ids),
  ])

  return {
    total: count ?? 0,
    results: rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      consentStream: row.consent_stream,
      segmentName: row.segment?.name ?? null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      run: row.send_run,
      send: summaries.get(row.id) ?? null,
      funnel: funnels.get(row.id) ?? EMPTY_FUNNEL,
    })),
  }
}

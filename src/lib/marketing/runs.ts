import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignRow, CampaignRunRow, Database } from '@/lib/db/types'

import { SEGMENT_MEMBER_CAP, segmentAudienceQuery } from './segments'

/**
 * Audience preparation for one campaign run (audit H7).
 *
 * The old send resolved the audience with a single `range(0, 9999)` read. PostgREST caps
 * a response at its `max-rows` setting (1,000 by default), so every recipient past that
 * cap was silently left out of the ledger — and the send then reported success.
 *
 * Now the audience is materialised into `campaign_sends` in keyset pages (ordered by
 * contact id, `id > cursor`), which is correct whatever the server's row cap is: a page
 * shorter than requested is not taken to mean the end, only an empty page is. Progress
 * is recorded in `campaign_runs` after every page, so an interrupted preparation
 * resumes from its cursor, and the ledger's unique index makes a repeated page harmless.
 * Dispatch refuses to start until the run is `prepared`.
 */

const PAGE_SIZE = 500

export class AudienceTooLargeError extends Error {
  constructor(readonly total: number) {
    super(
      `This audience has ${total.toLocaleString('en-AU')} contacts, over the ` +
        `${SEGMENT_MEMBER_CAP.toLocaleString('en-AU')} limit for one send. Narrow the segment ` +
        'or split it into several campaigns.'
    )
    this.name = 'AudienceTooLargeError'
  }
}

type RunCampaign = Pick<
  CampaignRow,
  'id' | 'send_run' | 'segment_id' | 'consent_stream' | 'revision' | 'approved_revision'
>

type Chainable = {
  gt(column: string, value: unknown): Chainable
  order(column: string, options: { ascending: boolean }): Chainable
  limit(count: number): Chainable
} & PromiseLike<{ data: Array<{ id: string }> | null; error: { message: string } | null; count?: number | null }>

async function loadSegmentDefinition(db: SupabaseClient<Database>, segmentId: string): Promise<unknown> {
  const { data, error } = await db
    .from('segments')
    .select('definition')
    .eq('id', segmentId)
    .maybeSingle()

  if (error) throw new Error(`Could not load the campaign segment: ${error.message}`)
  if (!data) throw new Error('The campaign segment no longer exists.')

  return data.definition
}

/** How many contacts the audience matches right now. Exact, not capped. */
export async function countCampaignAudience(
  db: SupabaseClient<Database>,
  params: { segmentId: string; definition?: unknown; stream: CampaignRow['consent_stream'] }
): Promise<number> {
  const definition = params.definition ?? (await loadSegmentDefinition(db, params.segmentId))
  const { query } = await segmentAudienceQuery(db, {
    segmentId: params.segmentId,
    definition,
    stream: params.stream,
    columns: 'id',
  })
  const { error, count } = await (query.range(0, 0) as unknown as PromiseLike<{
    error: { message: string } | null
    count: number | null
  }>)

  if (error) throw new Error(`Could not count the audience: ${error.message}`)

  return count ?? 0
}

async function readRun(
  db: SupabaseClient<Database>,
  campaignId: string,
  run: number
): Promise<CampaignRunRow | null> {
  const { data, error } = await db
    .from('campaign_runs')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('run', run)
    .maybeSingle()

  if (error) throw new Error(`Could not read the campaign run: ${error.message}`)

  return (data as CampaignRunRow | null) ?? null
}

async function countLedger(db: SupabaseClient<Database>, campaignId: string, run: number): Promise<number> {
  const { count, error } = await db
    .from('campaign_sends')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('run', run)

  if (error) throw new Error(`Could not count the recipient ledger: ${error.message}`)

  return count ?? 0
}

/**
 * Makes sure the campaign's current run has its complete recipient ledger.
 *
 * Idempotent and resumable. Returns the run once `audience_status` is `prepared`;
 * throws (leaving the recorded progress in place) if any read or write fails.
 */
export async function prepareCampaignRun(
  db: SupabaseClient<Database>,
  campaign: RunCampaign
): Promise<CampaignRunRow> {
  if (!campaign.segment_id) throw new Error('This campaign has no segment.')
  if (campaign.approved_revision === null || campaign.approved_revision !== campaign.revision) {
    throw new Error('This campaign must be approved in its current form before it is prepared.')
  }

  const run = campaign.send_run ?? 1
  let current = await readRun(db, campaign.id, run)

  if (current?.audience_status === 'prepared') return current

  const definition = await loadSegmentDefinition(db, campaign.segment_id)

  if (!current) {
    const expected = await countCampaignAudience(db, {
      segmentId: campaign.segment_id,
      definition,
      stream: campaign.consent_stream,
    })

    if (expected > SEGMENT_MEMBER_CAP) throw new AudienceTooLargeError(expected)
    if (expected === 0) throw new Error('This segment currently matches no subscribed contacts.')

    const { error } = await db.from('campaign_runs').upsert(
      {
        campaign_id: campaign.id,
        run,
        revision: campaign.approved_revision,
        segment_id: campaign.segment_id,
        consent_stream: campaign.consent_stream,
        expected_count: expected,
      },
      // A concurrent caller may have created it first; either row describes the run.
      { onConflict: 'campaign_id,run', ignoreDuplicates: true }
    )
    if (error) throw new Error(`Could not start the campaign run: ${error.message}`)

    current = await readRun(db, campaign.id, run)
    if (!current) throw new Error('The campaign run could not be read back.')
    if (current.audience_status === 'prepared') return current
  }

  // Materialise the audience the run was started for, which is the approved one.
  let cursor = current.audience_cursor

  for (;;) {
    const { query } = await segmentAudienceQuery(db, {
      segmentId: current.segment_id,
      definition,
      stream: current.consent_stream,
      columns: 'id',
    })
    let page = (query as unknown as Chainable).order('id', { ascending: true })
    if (cursor) page = page.gt('id', cursor)

    const { data, error } = await page.limit(PAGE_SIZE)
    if (error) throw new Error(`Could not read the audience: ${error.message}`)

    const ids = (data ?? []).map((row) => row.id)
    if (ids.length === 0) break

    const { error: insertError } = await db.from('campaign_sends').upsert(
      ids.map((contactId) => ({
        campaign_id: campaign.id,
        contact_id: contactId,
        run,
        status: 'pending' as const,
      })),
      { onConflict: 'campaign_id,contact_id,run', ignoreDuplicates: true }
    )
    if (insertError) throw new Error(`Could not prepare campaign sends: ${insertError.message}`)

    cursor = ids[ids.length - 1]
    const prepared = await countLedger(db, campaign.id, run)

    if (prepared > SEGMENT_MEMBER_CAP) throw new AudienceTooLargeError(prepared)

    const { error: progressError } = await db
      .from('campaign_runs')
      .update({ audience_cursor: cursor, prepared_count: prepared })
      .eq('campaign_id', campaign.id)
      .eq('run', run)
    if (progressError) throw new Error(`Could not record preparation progress: ${progressError.message}`)
  }

  const preparedCount = await countLedger(db, campaign.id, run)
  const { data: finished, error: finishError } = await db
    .from('campaign_runs')
    .update({
      audience_status: 'prepared',
      prepared_count: preparedCount,
      prepared_at: new Date().toISOString(),
    })
    .eq('campaign_id', campaign.id)
    .eq('run', run)
    .select('*')
    .single()

  if (finishError) throw new Error(`Could not finish preparing the run: ${finishError.message}`)

  return finished as CampaignRunRow
}

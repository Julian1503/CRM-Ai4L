import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import type { CampaignStatus, ConsentStream } from '@/lib/db/types'
import { CAMPAIGN_TRANSITIONS } from '@/lib/marketing/campaignStatus'
import { parseConsentStream } from '@/lib/marketing/consentStream'
import { createCampaign } from '@/lib/marketing/createCampaign'
import { readCampaignSendSummaries } from '@/lib/marketing/sendStatus'
import { buildPageMeta, getPageRange, readPageParams } from '@/lib/pagination'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

function readStatusFilter(value: string | null): CampaignStatus | null {
  return value !== null && Object.hasOwn(CAMPAIGN_TRANSITIONS, value)
    ? (value as CampaignStatus)
    : null
}

/**
 * Lists campaigns with their segment name, newest first.
 *
 * Bounded: campaigns accumulate and are never deleted, so an unbounded read would
 * eventually hit PostgREST's silent 1000-row cap.
 *
 * `?stream=` and `?status=` narrow the list. An unrecognised value is ignored rather
 * than answered with an empty page, which would read as "there are none".
 *
 * Live campaigns by default; `?archived=true` lists the archived ones instead. Removed
 * campaigns are never listed.
 */
/** Campaign statuses whose ledger the list reports. */
const REPORTED_STATUSES = new Set(['sending', 'failed'])

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const db = await createSupabaseServerClient()
    const pageParams = readPageParams(request.nextUrl.searchParams)
    const { from, to } = getPageRange(pageParams)

    const stream = parseConsentStream(request.nextUrl.searchParams.get('stream'))
    const status = readStatusFilter(request.nextUrl.searchParams.get('status'))

    let query = db.from('campaigns').select('*, segment:segments(name)', { count: 'exact' })

    query =
      request.nextUrl.searchParams.get('archived') === 'true'
        ? query.not('archived_at', 'is', null).is('removed_at', null)
        : query.is('archived_at', null)

    if (stream) query = query.eq('consent_stream', stream)
    if (status) query = query.eq('status', status)

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw new Error(error.message)

    // Ledger figures for the page's live sends, in the same response (audit A2): one
    // aggregate query instead of one request per campaign row.
    const reported = (data ?? []).filter((campaign) => REPORTED_STATUSES.has(campaign.status)).map((campaign) => campaign.id)
    const sendReports = Object.fromEntries(await readCampaignSendSummaries(db, reported))

    return ok({ campaigns: data ?? [], sendReports, ...buildPageMeta(pageParams, count ?? 0) })
  } catch (error) {
    return serverError(error, 'Could not load campaigns.')
  }
}

/**
 * Creates a campaign as a draft, through the shared `createCampaign` service.
 *
 * Status is never accepted from the caller — the database trigger rejects any insert
 * that is not `draft`, and the approval gate is the only way forward.
 *
 * The consent stream comes from the chosen template, read there rather than trusted from
 * the client: the template *is* the stream. With no template (an automation id typed by
 * hand) the caller must name the stream. Merge fields are checked against the
 * template's contract: reserved fields and unknown keys are refused.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)

  if (!body) {
    return badRequest('Expected a JSON object.')
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''

  if (!name) {
    return badRequest('A campaign name is required.')
  }

  const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : ''
  const requestedStream = parseConsentStream(body.consentStream)

  if (!templateId && !requestedStream) {
    return badRequest('Choose a template, or say which consent stream this campaign uses.')
  }

  try {
    const db = await createSupabaseServerClient()

    const outcome = await createCampaign(db, {
      name,
      segmentId: typeof body.segmentId === 'string' ? body.segmentId : null,
      source: templateId
        ? { kind: 'template', templateId }
        : {
            kind: 'manual',
            automationId: typeof body.providerAutomationId === 'string' ? body.providerAutomationId.trim() : null,
            // Checked above: without a template the stream was named explicitly.
            stream: requestedStream as ConsentStream,
          },
      mergeFields:
        typeof body.mergeFields === 'object' && body.mergeFields !== null && !Array.isArray(body.mergeFields)
          ? (body.mergeFields as Record<string, unknown>)
          : undefined,
      subject: typeof body.subject === 'string' ? body.subject.trim() : null,
      notes: typeof body.notes === 'string' ? body.notes.trim() : null,
    })

    if (!outcome.ok) {
      return outcome.reason === 'bad_request' ? badRequest(outcome.message) : conflict(outcome.message)
    }

    return ok({ campaign: outcome.campaign })
  } catch (error) {
    return serverError(error, 'Could not create campaign.')
  }
}

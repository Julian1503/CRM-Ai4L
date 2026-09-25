import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { isSendable } from '@/lib/marketing/campaignStatus'
import { loadEmailOctopusCredentials } from '@/lib/marketing/providers/credentials'
import { createEmailOctopusProvider } from '@/lib/marketing/providers/emailOctopus'
import { executeCampaignSends, prepareCampaignSends } from '@/lib/marketing/send'
import { resolveSegmentMembers } from '@/lib/marketing/segments'
import { readCampaignSendSummary } from '@/lib/marketing/sendStatus'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** How many recipients one invocation handles before returning. */
const CHUNK_SIZE = 200

/**
 * Sends one chunk of an approved campaign.
 *
 * Deliberately chunked rather than run to completion. EmailOctopus has no broadcast
 * send, so this is one API call per recipient against a 100-token bucket refilling at
 * 10/sec — a 10,000 contact segment is roughly 17 minutes, far past any serverless
 * request limit. The caller repeats this endpoint until `remaining` reaches zero; the
 * ledger makes that safe and resumable.
 */
export async function POST(
  request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params

  if (!id) {
    return badRequest('Campaign id is required.')
  }

  try {
    const db = await createSupabaseServerClient()

    const { data: campaign, error: loadError } = await db
      .from('campaigns')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!campaign) return notFound('Campaign not found.')

    const alreadySending = campaign.status === 'sending'
    const retryingFailed = campaign.status === 'failed'
    // Every ledger read and write below is scoped to this run. A re-opened campaign
    // starts a new one, so its history is added to rather than written over.
    const run = campaign.send_run ?? 1

    if (!alreadySending && !retryingFailed && !isSendable(campaign.status)) {
      return conflict(
        `A campaign in "${campaign.status}" cannot be sent. It must be approved first.`
      )
    }

    if (!campaign.segment_id) {
      return conflict('This campaign has no segment.')
    }

    if (!campaign.provider_automation_id?.trim()) {
      return conflict('Set the EmailOctopus automation ID before sending.')
    }

    // Provider credentials live server-side; they are never accepted from the client.
    const credentials = await loadEmailOctopusCredentials(db)

    if (!credentials) {
      return conflict('EmailOctopus credentials are not configured in Settings.')
    }

    const { apiKey, listId } = credentials

    // A retry only requeues ledger rows that definitively failed. Sent rows remain
    // immutable, so an operator can recover without emailing successful recipients
    // twice.
    if (retryingFailed) {
      const { error: resetError } = await db
        .from('campaign_sends')
        .update({ status: 'pending', error: null, provider_reference: null })
        .eq('campaign_id', campaign.id)
        .eq('run', run)
        .eq('status', 'failed')

      if (resetError) throw new Error(resetError.message)

      const { data: retryClaim, error: retryClaimError } = await db
        .from('campaigns')
        .update({ status: 'approved', completed_at: null })
        .eq('id', campaign.id)
        .eq('status', 'failed')
        .select('id')
        .maybeSingle()

      if (retryClaimError) throw new Error(retryClaimError.message)
      if (!retryClaim) return conflict('This campaign was already claimed for retry.')
    }

    // First invocation: claim the campaign and build the ledger.
    if (!alreadySending) {
      if (!retryingFailed) {
        const { data: segment, error: segmentError } = await db
          .from('segments')
          .select('definition')
          .eq('id', campaign.segment_id)
          .maybeSingle()

        if (segmentError) throw new Error(segmentError.message)
        if (!segment) return conflict('The campaign segment no longer exists.')

        const members = await resolveSegmentMembers(db, segment.definition, campaign.consent_stream)

        if (members.total === 0) {
          return conflict('This segment currently matches no subscribed contacts.')
        }

        await prepareCampaignSends(db, campaign.id, members.members, run)
      }

      const { data: sendClaim, error: claimError } = await db
        .from('campaigns')
        .update({ status: 'sending', started_at: new Date().toISOString() })
        .eq('id', campaign.id)
        // Only one caller can move approved -> sending, so a double click cannot
        // start two concurrent fan-outs.
        .eq('status', 'approved')
        .select('id')
        .maybeSingle()

      if (claimError) throw new Error(claimError.message)
      if (!sendClaim) return conflict('This campaign is already being sent.')
    }

    const provider = createEmailOctopusProvider({ apiKey, listId })

    // Booking links must be absolute and must point at the deployed host, not at
    // whatever origin happened to serve this request. Falls back to the request origin
    // so local development still produces working links.
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || request.nextUrl.origin

    const progress = await executeCampaignSends(db, provider, campaign, {
      maxToProcess: CHUNK_SIZE,
      baseUrl,
    })

    // Read cumulative ledger totals. Chunk-local numbers are not enough to decide
    // whether the campaign as a whole succeeded.
    const summary = await readCampaignSendSummary(db, campaign.id, run)
    const { pending, failed, sent } = summary
    let finalStatus: 'sending' | 'sent' | 'failed' = 'sending'

    if (pending === 0) {
      finalStatus = failed > 0 ? 'failed' : 'sent'
      const { error: completionError } = await db
        .from('campaigns')
        .update({ status: finalStatus, completed_at: new Date().toISOString() })
        .eq('id', campaign.id)
        .eq('status', 'sending')

      if (completionError) throw new Error(completionError.message)
    }

    return ok({
      status: finalStatus,
      processed: progress.total,
      sent,
      failed,
      pending,
      /** True while the caller should keep invoking this endpoint. */
      hasMore: pending > 0,
      /** Which fan-out these figures belong to. 1 unless the campaign was re-sent. */
      run,
      /**
       * What this invocation actually achieved.
       *
       * Separate from the cumulative totals because the caller needs both: the totals
       * say whether the campaign succeeded, and these say whether *this* chunk moved.
       * A chunk that processed recipients and neither sent nor failed any of them is
       * stalled — every attempt came back retryable — and looping on it forever is
       * how a rate-limited send used to masquerade as progress.
       */
      chunk: {
        processed: progress.total,
        sent: progress.sent,
        failed: progress.failed,
        deferred: progress.remaining,
        reason: progress.deferredReason ?? null,
      },
      /** Why recipients failed, in the provider's own words. Null when none did. */
      failureReason: summary.failureReason ?? progress.failureReason ?? null,
    })
  } catch (error) {
    return serverError(error, 'Could not send campaign.')
  }
}

/**
 * Reports what happened to a campaign's recipients.
 *
 * Exists so a failure survives the click that caused it: the POST response is gone as
 * soon as the operator reloads, while a campaign sitting in `failed` needs to be able
 * to say why on every visit.
 */
export async function GET(
  _request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params

  if (!id) {
    return badRequest('Campaign id is required.')
  }

  try {
    const db = await createSupabaseServerClient()

    const { data: campaign, error: loadError } = await db
      .from('campaigns')
      .select('send_run')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!campaign) return notFound('Campaign not found.')

    return ok(await readCampaignSendSummary(db, id, campaign.send_run ?? 1))
  } catch (error) {
    return serverError(error, 'Could not read the send report.')
  }
}

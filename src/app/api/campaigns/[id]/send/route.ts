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
import { createEmailOctopusProvider } from '@/lib/marketing/providers/emailOctopus'
import { executeCampaignSends, prepareCampaignSends } from '@/lib/marketing/send'
import { resolveSegmentMembers } from '@/lib/marketing/segments'
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
    const { data: credentials, error: credentialsError } = await db
      .from('credentials')
      .select('key, value')

    if (credentialsError) throw new Error(credentialsError.message)

    const byKey = Object.fromEntries(
      (credentials ?? []).map((row) => [row.key, row.value])
    ) as Record<string, string>

    const apiKey = byKey.emailoctopus_api_key?.trim()
    const listId = byKey.emailoctopus_list_id?.trim()

    if (!apiKey || !listId) {
      return conflict('EmailOctopus credentials are not configured in Settings.')
    }

    // A retry only requeues ledger rows that definitively failed. Sent rows remain
    // immutable, so an operator can recover without emailing successful recipients
    // twice.
    if (retryingFailed) {
      const { error: resetError } = await db
        .from('campaign_sends')
        .update({ status: 'pending', error: null, provider_reference: null })
        .eq('campaign_id', campaign.id)
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

        const members = await resolveSegmentMembers(db, segment.definition)

        if (members.total === 0) {
          return conflict('This segment currently matches no subscribed contacts.')
        }

        await prepareCampaignSends(db, campaign.id, members.members)
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
    const { count: stillPending, error: pendingCountError } = await db
      .from('campaign_sends')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('status', 'pending')

    if (pendingCountError) throw new Error(pendingCountError.message)

    const { count: totalFailed, error: failedCountError } = await db
      .from('campaign_sends')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('status', 'failed')

    if (failedCountError) throw new Error(failedCountError.message)

    const { count: totalSent, error: sentCountError } = await db
      .from('campaign_sends')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('status', 'sent')

    if (sentCountError) throw new Error(sentCountError.message)

    const pending = stillPending ?? 0
    const failed = totalFailed ?? 0
    const sent = totalSent ?? 0
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
    })
  } catch (error) {
    return serverError(error, 'Could not send campaign.')
  }
}

import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import { badRequest, conflict, notFound, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { isSendable } from '@/lib/marketing/campaignStatus'
import { isEmailDynamicEnabled } from '@/lib/content-studio/flags'
import { ContentResolutionError, resolveSendContent } from '@/lib/marketing/campaignContent'
import { loadEmailOctopusCredentials, loadEmailOctopusStatus } from '@/lib/marketing/providers/credentials'
import { studioPreflight, type StudioPreflight } from '@/lib/marketing/studioPreflight'
import { measureSegmentAudience, SEGMENT_MEMBER_CAP } from '@/lib/marketing/segments'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** Validates every local prerequisite before the operator confirms a real send. */
export async function GET(
  _request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  if (!id) return badRequest('Campaign id is required.')

  try {
    const db = await createSupabaseServerClient()
    const { data: campaign, error } = await db
      .from('campaigns')
      .select('id, status, send_run, segment_id, provider_automation_id, consent_stream, merge_fields, content_snapshot_id, segment:segments(definition)')
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!campaign) return notFound('Campaign not found.')
    if (campaign.status !== 'sending' && campaign.status !== 'failed' && !isSendable(campaign.status)) {
      return conflict(`A campaign in "${campaign.status}" cannot be sent. It must be approved first.`)
    }
    if (!campaign.segment_id) return conflict('This campaign has no audience segment.')
    if (!campaign.provider_automation_id?.trim()) return conflict('Connect an EmailOctopus template before sending.')

    if (!(await loadEmailOctopusStatus()).configured) {
      return conflict('EmailOctopus is not connected. Open Settings to finish setup.')
    }

    const segment = campaign.segment as unknown as { definition: Record<string, unknown> } | null
    if (!segment) return conflict('The campaign audience no longer exists.')

    // Studio emails also check their snapshot, images, provider fields and CTA. Hand-
    // written campaigns answer exactly as before.
    let studio: StudioPreflight | null = null
    if (campaign.content_snapshot_id) {
      try {
        studio = await studioPreflight(db, await resolveSendContent(db, campaign), {
          dynamicEnabled: isEmailDynamicEnabled(),
          credentials: await loadEmailOctopusCredentials(),
        })
      } catch (error) {
        if (!(error instanceof ContentResolutionError)) throw error
        return conflict(error.message)
      }
    }
    const contentReady = !studio || studio.problems.length === 0
    const extra = studio ? { studio } : {}

    // Once a run's audience is materialised, the send goes to that snapshot (minus anyone
    // who becomes ineligible), not to whatever the segment matches now.
    const { data: run, error: runError } = await db
      .from('campaign_runs')
      .select('audience_status, prepared_count, expected_count')
      .eq('campaign_id', campaign.id)
      .eq('run', campaign.send_run)
      .maybeSingle()
    if (runError) throw new Error(runError.message)

    if (run?.audience_status === 'prepared') {
      return ok({ ready: run.prepared_count > 0 && contentReady, total: run.prepared_count, truncated: false, prepared: true, ...extra })
    }

    const members = await measureSegmentAudience(
      db,
      { id: campaign.segment_id, definition: segment.definition },
      campaign.consent_stream
    )
    return ok({
      // Over the cap is refused outright rather than sent to the first N (audit H7).
      ready: members.total > 0 && !members.truncated && contentReady,
      total: members.total,
      truncated: members.truncated,
      limit: SEGMENT_MEMBER_CAP,
      prepared: false,
      ...extra,
    })
  } catch (error) {
    return serverError(error, 'Could not run campaign preflight.')
  }
}

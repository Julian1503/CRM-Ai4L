import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { isArchiveRuleError } from '@/lib/lifecycle/lifecycle'
import { isEmailDynamicEnabled } from '@/lib/content-studio/flags'
import { assessContent, ContentResolutionError, resolveSendContent } from '@/lib/marketing/campaignContent'
import { checkApprovable } from '@/lib/marketing/campaignStatus'
import { countCampaignAudience } from '@/lib/marketing/runs'
import { SEGMENT_MEMBER_CAP } from '@/lib/marketing/segments'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * Approves a campaign for sending.
 *
 * The human gate. Everything before this is reversible; everything after queues real
 * mail at the provider, which cannot be recalled. Approval is attributed to the
 * signed-in user, and the database trigger independently refuses to record an approval
 * without `approved_by` and a provider automation id.
 *
 * The approval is of one revision (audit H6): the body carries `{ revision }`, the one
 * the reviewer was looking at, and the update is conditioned on it. If the campaign
 * changed in the meantime the approval is refused rather than applied to content nobody
 * reviewed. An audience over the send limit is refused here, before anyone expects it
 * to go (audit H7).
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

  const body = await readJsonBody(request)
  const revision = body?.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    return badRequest('Send the revision being approved as { revision }.')
  }

  try {
    const db = await createSupabaseServerClient()

    const { data: campaign, error: loadError } = await db
      .from('campaigns')
      .select('id, status, revision, consent_stream, provider_automation_id, segment_id, archived_at, removed_at, merge_fields, content_snapshot_id')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!campaign || campaign.removed_at) return notFound('Campaign not found.')
    if (campaign.archived_at) return conflict('This campaign is archived. Restore it before approving it.')

    // A Studio email is approved as its snapshot: re-validated against its contract,
    // and refused while its delivery mode is switched off. Approving the source post
    // never authorised this; this is the email's own gate.
    let contentProblems: string[] = []
    if (campaign.content_snapshot_id) {
      try {
        const content = await resolveSendContent(db, campaign)
        contentProblems = assessContent(content, { dynamicEnabled: isEmailDynamicEnabled() })
      } catch (error) {
        if (!(error instanceof ContentResolutionError)) throw error
        contentProblems = [error.message]
      }
    }

    const check = checkApprovable({
      status: campaign.status,
      providerAutomationId: campaign.provider_automation_id,
      segmentId: campaign.segment_id,
      contentProblems,
    })

    if (!check.ok) {
      return conflict(check.reason)
    }

    if (campaign.revision !== revision) {
      return conflict('This campaign changed since you opened it. Review the current version before approving.')
    }

    const audience = await countCampaignAudience(db, {
      segmentId: campaign.segment_id as string,
      stream: campaign.consent_stream,
    })
    if (audience === 0) return conflict('This segment currently matches no subscribed contacts.')
    if (audience > SEGMENT_MEMBER_CAP) {
      return conflict(
        `This audience has ${audience.toLocaleString('en-AU')} contacts, over the ` +
          `${SEGMENT_MEMBER_CAP.toLocaleString('en-AU')} limit for one send. Narrow the segment ` +
          'or split it into several campaigns.'
      )
    }

    const { data, error } = await db
      .from('campaigns')
      .update({
        status: 'approved',
        approved_by: guard.session.userId,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      // Guards against two reviewers approving concurrently: the second update
      // matches nothing rather than overwriting the first approval.
      .eq('status', campaign.status)
      .eq('revision', revision)
      .select('*')
      .maybeSingle()

    // Its segment was archived: the trigger refuses to approve a send to it.
    if (isArchiveRuleError(error)) return conflict(error?.message ?? 'The segment is archived.')
    if (error?.code === 'CRM04') return conflict(error.message)
    if (error) throw new Error(error.message)
    if (!data) {
      return conflict('This campaign changed or was approved by someone else. Reload and review it again.')
    }

    return ok({ campaign: data, audience })
  } catch (error) {
    return serverError(error, 'Could not approve campaign.')
  }
}

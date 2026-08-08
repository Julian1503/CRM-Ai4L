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
import { checkApprovable } from '@/lib/marketing/campaignStatus'
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
 */
export async function POST(
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
      .select('id, status, provider_automation_id, segment_id')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!campaign) return notFound('Campaign not found.')

    const check = checkApprovable({
      status: campaign.status,
      providerAutomationId: campaign.provider_automation_id,
      segmentId: campaign.segment_id,
    })

    if (!check.ok) {
      return conflict(check.reason)
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
      .select('*')
      .single()

    if (error) throw new Error(error.message)

    return ok({ campaign: data })
  } catch (error) {
    return serverError(error, 'Could not approve campaign.')
  }
}

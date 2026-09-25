import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import { badRequest, conflict, notFound, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { isSendable } from '@/lib/marketing/campaignStatus'
import { resolveSegmentMembers } from '@/lib/marketing/segments'
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
      .select('id, status, segment_id, provider_automation_id, consent_stream, segment:segments(definition)')
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!campaign) return notFound('Campaign not found.')
    if (campaign.status !== 'sending' && campaign.status !== 'failed' && !isSendable(campaign.status)) {
      return conflict(`A campaign in "${campaign.status}" cannot be sent. It must be approved first.`)
    }
    if (!campaign.segment_id) return conflict('This campaign has no audience segment.')
    if (!campaign.provider_automation_id?.trim()) return conflict('Connect an EmailOctopus template before sending.')

    const { data: credentials, error: credentialsError } = await db
      .from('credentials')
      .select('key, value')
    if (credentialsError) throw new Error(credentialsError.message)

    const keys = new Set((credentials ?? []).map((row) => row.key))
    if (!keys.has('emailoctopus_api_key') || !keys.has('emailoctopus_list_id')) {
      return conflict('EmailOctopus is not connected. Open Settings to finish setup.')
    }

    const segment = campaign.segment as unknown as { definition: Record<string, unknown> } | null
    if (!segment) return conflict('The campaign audience no longer exists.')

    const members = await resolveSegmentMembers(db, segment.definition, campaign.consent_stream)
    return ok({ ready: members.total > 0, total: members.total, truncated: members.truncated })
  } catch (error) {
    return serverError(error, 'Could not run campaign preflight.')
  }
}

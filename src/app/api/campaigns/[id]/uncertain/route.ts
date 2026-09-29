import type { NextRequest, NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * Reconciles recipients whose provider outcome is unknown (audit H3).
 *
 * A timeout or a 5xx on the EmailOctopus queue call, or a worker that died mid-call,
 * leaves a recipient `uncertain`. Nothing retries those automatically — the email may
 * already be in their inbox. After checking the automation's activity in EmailOctopus,
 * an operator settles them all one way:
 *
 *   { resolution: 'sent' }   they did receive it
 *   { resolution: 'retry' }  they did not; queue them again (sent on the next retry)
 */
export async function POST(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const body = await readJsonBody(request)
  const resolution = body?.resolution

  if (resolution !== 'sent' && resolution !== 'retry') {
    return badRequest('resolution must be "sent" or "retry".')
  }

  try {
    const db = await createSupabaseServerClient()
    const { data: campaign, error: loadError } = await db
      .from('campaigns')
      .select('id, status, send_run, removed_at')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!campaign || campaign.removed_at) return notFound('Campaign not found.')
    if (campaign.status === 'sending') {
      return conflict('Wait for the send to finish before reconciling uncertain recipients.')
    }

    const { data, error } = await db.rpc('resolve_uncertain_campaign_sends', {
      p_campaign_id: id,
      p_run: campaign.send_run,
      p_resolution: resolution,
    })
    if (error) throw new Error(error.message)

    return ok({ resolved: data ?? 0, resolution })
  } catch (error) {
    return serverError(error, 'Could not reconcile the uncertain recipients.')
  }
}

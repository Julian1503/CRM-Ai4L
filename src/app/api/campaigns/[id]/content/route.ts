import type { NextRequest, NextResponse } from 'next/server'

import { conflict, notFound, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { ContentResolutionError, readCampaignContentSummary } from '@/lib/marketing/campaignContent'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/campaigns/[id]/content -> { content: CampaignContentSummary | null }
 *
 * The Content Studio snapshot a campaign sends (fields, CTA, images, reference HTML) and
 * the Studio item it came from. Null for hand-written campaigns, whose copy is their
 * merge fields.
 */
export async function GET(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params

  try {
    const db = await createSupabaseServerClient()
    const { data: campaign, error } = await db
      .from('campaigns')
      .select('id, content_snapshot_id, removed_at')
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!campaign || campaign.removed_at) return notFound('Campaign not found.')
    if (!campaign.content_snapshot_id) return ok({ content: null })

    return ok({ content: await readCampaignContentSummary(db, campaign.content_snapshot_id) })
  } catch (error) {
    if (error instanceof ContentResolutionError) return conflict(error.message)
    return serverError(error, 'Could not load the campaign content.')
  }
}

import type { NextRequest, NextResponse } from 'next/server'

import { readJsonBody, requireSessionOr401 } from '@/lib/api/responses'
import { isUuid } from '@/lib/contacts/tags'
import { contentErrorResponse, errorResponse, featureDisabled } from '@/lib/content-studio/errors'
import { isContentStudioEnabled, isEmailBridgeEnabled } from '@/lib/content-studio/flags'
import { json, type IdContext } from '@/lib/content-studio/userRoute'
import { createStudioEmail, proposeStudioEmail } from '@/lib/marketing/studioEmail'
import { parseStudioEmailRequest } from '@/lib/marketing/studioEmailRequest'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * GET  /api/content-studio/variants/[id]/email-draft -> { proposal }
 *      The current revision adapted to email slots, with image previews.
 * POST /api/content-studio/variants/[id]/email-draft
 *      { idempotencyKey, revisionId, templateId, segmentId?, campaignName, notes?, subject,
 *        ctaMode, ctaUrl?, fields, assets: [{ assetId, alt }] }
 *      -> 201 { campaignId, snapshotId, created, contentHash } (200 on a replay)
 *
 * Creates a DRAFT campaign from a snapshot of the content. It still needs its own
 * approval in Campaigns: approving the post does not authorise an email.
 */
async function guard(context: IdContext): Promise<{ id: string; userId: string } | { response: NextResponse }> {
  const session = await requireSessionOr401()
  if ('response' in session) return session
  if (!isContentStudioEnabled() || !isEmailBridgeEnabled()) return { response: featureDisabled('Creating emails from the Content Studio is not enabled.') }
  const { id } = await context.params
  if (!isUuid(id)) return { response: errorResponse(404, 'Variant not found.') }
  return { id, userId: session.session.userId }
}

export async function GET(_request: NextRequest, context: IdContext): Promise<NextResponse> {
  const checked = await guard(context)
  if ('response' in checked) return checked.response

  try {
    const db = await createSupabaseServerClient()
    return json({ proposal: await proposeStudioEmail(db, checked.id) })
  } catch (error) {
    return contentErrorResponse(error, 'Could not prepare the email.')
  }
}

export async function POST(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const checked = await guard(context)
  if ('response' in checked) return checked.response

  const body = await readJsonBody(request)
  if (!body) return errorResponse(400, 'Expected a JSON object.')
  const parsed = parseStudioEmailRequest(body, 'campaign')
  if (!parsed.ok) return errorResponse(400, parsed.error)

  try {
    const db = await createSupabaseServerClient()
    const result = await createStudioEmail(db, checked.id, checked.userId, parsed.value, 'campaign')
    return json(
      { campaignId: result.campaignId, snapshotId: result.snapshotId, created: result.created, contentHash: result.contentHash },
      result.created ? 201 : 200
    )
  } catch (error) {
    return contentErrorResponse(error, 'Could not create the email draft.')
  }
}

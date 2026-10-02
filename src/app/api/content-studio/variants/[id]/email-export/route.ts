import type { NextRequest, NextResponse } from 'next/server'

import { readJsonBody, requireSessionOr401 } from '@/lib/api/responses'
import { isUuid } from '@/lib/contacts/tags'
import { contentErrorResponse, errorResponse, featureDisabled } from '@/lib/content-studio/errors'
import { isContentStudioEnabled, isEmailBridgeEnabled } from '@/lib/content-studio/flags'
import { json, type IdContext } from '@/lib/content-studio/userRoute'
import { createStudioEmail } from '@/lib/marketing/studioEmail'
import { parseStudioEmailRequest } from '@/lib/marketing/studioEmailRequest'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * POST /api/content-studio/variants/[id]/email-export
 *      { idempotencyKey, revisionId, subject, ctaMode (external_url|none), ctaUrl?, fields, assets }
 *      -> 201 { html, text, snapshotId, contentHash } (200 on a replay)
 *
 * Renders the email as HTML and plain text for a campaign managed in EmailOctopus, and
 * records it as an export snapshot. An export is not a delivery: nothing is sent, and
 * nothing here reports that anyone received it.
 */
export async function POST(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const session = await requireSessionOr401()
  if ('response' in session) return session.response
  if (!isContentStudioEnabled() || !isEmailBridgeEnabled()) {
    return featureDisabled('Creating emails from the Content Studio is not enabled.')
  }

  const { id } = await context.params
  if (!isUuid(id)) return errorResponse(404, 'Variant not found.')

  const body = await readJsonBody(request)
  if (!body) return errorResponse(400, 'Expected a JSON object.')
  const parsed = parseStudioEmailRequest(body, 'export')
  if (!parsed.ok) return errorResponse(400, parsed.error)

  try {
    const db = await createSupabaseServerClient()
    const result = await createStudioEmail(db, id, session.session.userId, parsed.value, 'export')
    return json(
      { html: result.html, text: result.text, snapshotId: result.snapshotId, contentHash: result.contentHash },
      result.created ? 201 : 200
    )
  } catch (error) {
    return contentErrorResponse(error, 'Could not export the email.')
  }
}

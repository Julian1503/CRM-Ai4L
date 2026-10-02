import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { reviewRevision } from '@/lib/content-studio/approvals'
import { json, readRouteId, readValidBody, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'
import { parseReview } from '@/lib/content-studio/validation'

export const runtime = 'nodejs'

/** POST /api/content-studio/variants/[id]/review -> 201 { review }; only the current revision (409 stale_revision). */
export async function POST(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not record the review.', async ({ db }) => {
    const variantId = await readRouteId(context, 'Variant not found.')
    const body = await readValidBody(request, parseReview)
    return json({ review: await reviewRevision(db, variantId, body) }, 201)
  })
}

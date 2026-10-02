import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { createPublicationResponse, listPublicationsResponse } from '@/lib/social/routeHandlers'

export const runtime = 'nodejs'

/** GET /api/social/publications?itemId= → { publications } (without itemId: the most recent). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response
  return listPublicationsResponse(request)
}

/**
 * POST /api/social/publications { revisionId, accountId, idempotencyKey } → 202 { publication }.
 * Re-runs the preflight (422 preflight_failed on any blocking issue), publishes the
 * revision's images as immutable public copies and queues the publish_social job.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response
  return createPublicationResponse(guard.session, request)
}

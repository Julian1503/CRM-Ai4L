import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { preflightResponse } from '@/lib/social/routeHandlers'

export const runtime = 'nodejs'

/** POST /api/social/publications/preflight { revisionId, accountId, idempotencyKey } → { preflight }. Read-only. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response
  return preflightResponse(request)
}

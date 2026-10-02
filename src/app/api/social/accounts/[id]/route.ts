import type { NextRequest, NextResponse } from 'next/server'

import { forbidden, requireSessionOr401 } from '@/lib/api/responses'
import { disconnectAccountResponse } from '@/lib/social/routeHandlers'

export const runtime = 'nodejs'

type IdContext = { params: Promise<{ id: string }> }

/**
 * PATCH /api/social/accounts/[id] { action: 'disconnect' } → { account } (administrators).
 * The row is kept with status 'disconnected'; publications keep their reference.
 */
export async function PATCH(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response
  if (guard.session.role !== 'admin') return forbidden('Only an administrator can do that.')

  const { id } = await context.params
  return disconnectAccountResponse(guard.session, request, id)
}

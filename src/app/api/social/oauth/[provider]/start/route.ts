import type { NextRequest, NextResponse } from 'next/server'

import { forbidden, requireSessionOr401 } from '@/lib/api/responses'
import { startConnectResponse } from '@/lib/social/routeHandlers'

export const runtime = 'nodejs'

type ProviderContext = { params: Promise<{ provider: string }> }

/**
 * POST /api/social/oauth/[provider]/start (administrators; a same-origin form post from
 * Settings). Redirects to the provider's consent screen, or back to Settings with
 * `?social=error&reason=<code>`.
 */
export async function POST(request: NextRequest, context: ProviderContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response
  if (guard.session.role !== 'admin') return forbidden('Only an administrator can do that.')

  const { provider } = await context.params
  return startConnectResponse(guard.session, request, provider)
}

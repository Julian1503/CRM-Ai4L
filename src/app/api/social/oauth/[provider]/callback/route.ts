import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { settingsRedirect } from '@/lib/social/oauthHttp'
import { connectCallbackResponse } from '@/lib/social/routeHandlers'

export const runtime = 'nodejs'

type ProviderContext = { params: Promise<{ provider: string }> }

/**
 * GET /api/social/oauth/[provider]/callback — the provider redirects the administrator's
 * browser here with `code` and `state`. Always answers with a redirect to Settings
 * (`?social=connected|error`); never echoes the code, the state or a token.
 */
export async function GET(request: NextRequest, context: ProviderContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return settingsRedirect(request, 'error', { reason: 'not_authorised' })
  if (guard.session.role !== 'admin') return settingsRedirect(request, 'error', { reason: 'not_authorised' })

  const { provider } = await context.params
  return connectCallbackResponse(guard.session, request, provider)
}

import type { NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { listAccountsResponse } from '@/lib/social/routeHandlers'

export const runtime = 'nodejs'

/** GET /api/social/accounts → { accounts, enabledPlatforms } for any approved member. No token fields. */
export async function GET(): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response
  return listAccountsResponse()
}

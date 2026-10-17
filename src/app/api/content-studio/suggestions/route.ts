import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { getSuggestions } from '@/lib/content-studio/suggestions'
import { json, readValidBody, runContentRoute } from '@/lib/content-studio/userRoute'
import { parseSuggestionRequest } from '@/lib/content-studio/validation'

export const runtime = 'nodejs'
/** The engine answers within 25 s; the rest is headroom for the database round trips. */
export const maxDuration = 60

/**
 * POST /api/content-studio/suggestions -> 200 { kind, cached, suggestions | completion }.
 * 429 after a member's 50th request in a minute; 503 when the engine cannot answer.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not load suggestions.', async ({ db }) => {
    const body = await readValidBody(request, parseSuggestionRequest)
    return json(await getSuggestions(db, body))
  })
}

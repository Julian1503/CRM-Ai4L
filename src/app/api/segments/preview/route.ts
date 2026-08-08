import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { badRequest, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { estimateDrainMs } from '@/lib/marketing/rateLimiter'
import { resolveSegmentMembers, segmentDefinitionToFilters } from '@/lib/marketing/segments'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Live member count for a draft segment definition.
 *
 * Also returns the estimated send duration, because with a per-contact send against a
 * 100-token bucket refilling at 10/sec, audience size translates directly into wall
 * clock — a 10k segment is ~17 minutes. Better to see that while defining the segment
 * than after approving the campaign.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)

  if (!body) {
    return badRequest('Expected a JSON object.')
  }

  try {
    const db = await createSupabaseServerClient()
    const filters = segmentDefinitionToFilters(body.definition)
    const members = await resolveSegmentMembers(db, body.definition)

    return ok({
      total: members.total,
      truncated: members.truncated,
      estimatedSendMs: estimateDrainMs(members.total),
      // Echoed back so the UI can show what was actually applied, including the
      // invariants the definition cannot override.
      appliedFilters: {
        state: filters.state,
        status: filters.status,
        jobTypeId: filters.jobTypeId,
        subscribedOnly: filters.subscribed === true,
      },
      sample: members.members.slice(0, 5),
    })
  } catch (error) {
    return serverError(error, 'Could not preview segment.')
  }
}

export function GET(): NextResponse {
  return NextResponse.json(
    { error: 'Use POST with a segment definition.' },
    { status: 405 }
  )
}

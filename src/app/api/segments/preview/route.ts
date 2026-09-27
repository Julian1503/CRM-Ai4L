import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { badRequest, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { resolveSegmentFacets } from '@/lib/marketing/facets'
import { estimateDrainMs } from '@/lib/marketing/rateLimiter'
import { readConsentStream } from '@/lib/marketing/consentStream'
import { criteriaToDefinition, parseSegmentCriteria } from '@/lib/marketing/segmentCriteria'
import { resolveSegmentAudience } from '@/lib/marketing/segments'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Live member count for a draft segment definition.
 *
 * Also returns the estimated send duration, because with a per-contact send against a
 * 100-token bucket refilling at 10/sec, audience size translates directly into wall
 * clock — a 10k segment is ~17 minutes. Better to see that while defining the segment
 * than after approving the campaign.
 *
 * `facets` carries the same audience counted per dropdown option, so the builder can
 * show what each state, job type and status would leave you with before you pick it.
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
    // A segment carries no stream of its own — the campaign it is used by does. The
    // builder says which one it is previewing for; without an answer this counts the
    // newsletter audience, which is the narrower of the two.
    const stream = readConsentStream(body.stream)
    const criteria = parseSegmentCriteria(body.definition)
    // An existing segment being edited is previewed with its manual overrides, so the
    // count matches what saving would give. A new one has none yet.
    const segment = {
      id: typeof body.segmentId === 'string' && body.segmentId ? body.segmentId : null,
      definition: criteriaToDefinition(criteria),
    }
    // Independent reads of the same audience; serialising them would double the
    // latency of a preview that fires on every dropdown change. Five rows is all the
    // sample needs -- the total comes from the exact count, not from reading everyone.
    const [members, facets] = await Promise.all([
      resolveSegmentAudience(db, { segmentId: segment.id, definition: segment.definition, stream, page: 1, pageSize: 5 }),
      resolveSegmentFacets(db, segment, stream),
    ])

    return ok({
      total: members.total,
      truncated: members.truncated,
      estimatedSendMs: estimateDrainMs(members.total),
      facets,
      // Echoed back so the UI can show what was actually applied, including the
      // invariants the definition cannot override.
      stream,
      appliedFilters: { ...criteria, subscribedOnly: true },
      sample: members.members,
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

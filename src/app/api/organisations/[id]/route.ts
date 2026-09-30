import type { NextRequest, NextResponse } from 'next/server'

import { badRequest, conflict, notFound, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { parseIndustry, updateOrganisationIndustry } from '@/lib/contacts/organisations'
import { isUuid } from '@/lib/contacts/tags'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

// Next.js 16: dynamic route params are delivered as a Promise.
type RouteContext = { params: Promise<{ id: string }> }

/**
 * Sets an organisation's industry: `{ industry: string | null, expectedIndustry:
 * string | null }`.
 *
 * The industry is shared by every contact of the organisation. `expectedIndustry` is
 * the value the editor loaded; if the organisation no longer holds it, nothing is
 * written and the answer is 409, so one editor never silently overwrites another.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  if (!isUuid(id)) return notFound('Organisation not found.')

  const body = await readJsonBody(request)
  if (!body) return badRequest('Expected a JSON object.')

  // Required, and null is a real value ("had no industry"), so absence is an error.
  if (!('industry' in body) || !('expectedIndustry' in body)) {
    return badRequest('industry and expectedIndustry are required (either may be null).')
  }
  const expectedIndustry = body.expectedIndustry
  if (expectedIndustry !== null && typeof expectedIndustry !== 'string') {
    return badRequest('expectedIndustry must be text or null.')
  }

  const parsed = parseIndustry(body.industry)
  if (!parsed.ok) return badRequest(parsed.error)

  try {
    const db = await createSupabaseServerClient()
    const result = await updateOrganisationIndustry(db, { id, industry: parsed.industry, expectedIndustry })

    if (result.kind === 'not_found') return notFound('Organisation not found.')
    if (result.kind === 'conflict') {
      return conflict("Someone else changed this organisation's industry. Reload to see the current value.")
    }

    return ok({ organisation: result.organisation })
  } catch (error) {
    return serverError(error, 'Could not update the organisation.')
  }
}

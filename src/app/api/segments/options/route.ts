import type { NextRequest, NextResponse } from 'next/server'

import { ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { escapeLikePattern } from '@/lib/contacts/query'
import { SEGMENT_SOURCES } from '@/lib/marketing/segmentCriteria'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/** Organisations are many; the picker searches rather than listing them all. */
const ORGANISATION_RESULTS = 20
const SERVICE_LIMIT = 200

/**
 * Choices for the segment criteria that are not fixed lists in the code.
 *
 *   ?org=acme       organisations whose name contains the term
 *   ?orgId=<id>     one organisation by id, to label a saved criterion
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const term = request.nextUrl.searchParams.get('org')?.trim() ?? ''
  const orgId = request.nextUrl.searchParams.get('orgId')?.trim() ?? ''

  try {
    const db = await createSupabaseServerClient()

    const services = db.from('services').select('id, name').order('name', { ascending: true }).limit(SERVICE_LIMIT)

    let organisations = db.from('organisations').select('id, name').order('name', { ascending: true })

    if (orgId) organisations = organisations.eq('id', orgId)
    else if (term) organisations = organisations.ilike('name', `%${escapeLikePattern(term)}%`)

    const [serviceResult, organisationResult] = await Promise.all([
      services,
      term || orgId ? organisations.limit(ORGANISATION_RESULTS) : Promise.resolve({ data: [], error: null }),
    ])

    if (serviceResult.error) throw new Error(serviceResult.error.message)
    if (organisationResult.error) throw new Error(organisationResult.error.message)

    return ok({
      services: serviceResult.data ?? [],
      organisations: organisationResult.data ?? [],
      sources: SEGMENT_SOURCES,
    })
  } catch (error) {
    return serverError(error, 'Could not load segment options.')
  }
}

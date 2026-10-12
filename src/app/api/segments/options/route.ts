import type { NextRequest, NextResponse } from 'next/server'

import { ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { escapeLikePattern } from '@/lib/contacts/query'
import { NO_TAG, parseSegmentCriteria, SEGMENT_SOURCES } from '@/lib/marketing/segmentCriteria'
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
 *   ?tagIds=a,b     those tags by id, to label a saved segment's tag chips. A tag no
 *                   longer in the catalogue is simply absent; the editor shows it as
 *                   "Removed tag" so it can be taken out of the segment.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const term = request.nextUrl.searchParams.get('org')?.trim() ?? ''
  const orgId = request.nextUrl.searchParams.get('orgId')?.trim() ?? ''
  const tagIds = (parseSegmentCriteria({ tagIds: request.nextUrl.searchParams.get('tagIds') ?? '' }).tagIds ?? []).filter(
    (tagId) => tagId !== NO_TAG
  )

  try {
    const db = await createSupabaseServerClient()

    const services = db.from('services').select('id, name').order('name', { ascending: true }).limit(SERVICE_LIMIT)

    let organisations = db.from('organisations').select('id, name').order('name', { ascending: true })

    if (orgId) organisations = organisations.eq('id', orgId)
    else if (term) organisations = organisations.ilike('name', `%${escapeLikePattern(term)}%`)

    const [serviceResult, organisationResult, tagResult] = await Promise.all([
      services,
      term || orgId ? organisations.limit(ORGANISATION_RESULTS) : Promise.resolve({ data: [], error: null }),
      tagIds.length > 0
        ? db.from('tags').select('id, name').in('id', tagIds).order('name', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ])

    if (serviceResult.error) throw new Error(serviceResult.error.message)
    if (organisationResult.error) throw new Error(organisationResult.error.message)
    if (tagResult.error) throw new Error(tagResult.error.message)

    return ok({
      services: serviceResult.data ?? [],
      organisations: organisationResult.data ?? [],
      tags: tagResult.data ?? [],
      sources: SEGMENT_SOURCES,
    })
  } catch (error) {
    return serverError(error, 'Could not load segment options.')
  }
}

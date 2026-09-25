import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { badRequest, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { buildPageMeta, getPageRange, readPageParams } from '@/lib/pagination'
import { readConsentStream } from '@/lib/marketing/consentStream'
import {
  filtersToSegmentDefinition,
  resolveSegmentMembers,
  segmentDefinitionToFilters,
} from '@/lib/marketing/segments'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/** Lists segments, newest first, bounded to one page. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const db = await createSupabaseServerClient()
    const pageParams = readPageParams(request.nextUrl.searchParams)
    const { from, to } = getPageRange(pageParams)

    const { data, error, count } = await db
      .from('segments')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw new Error(error.message)

    return ok({ segments: data ?? [], ...buildPageMeta(pageParams, count ?? 0) })
  } catch (error) {
    return serverError(error, 'Could not load segments.')
  }
}

/** Creates a segment. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)

  if (!body) {
    return badRequest('Expected a JSON object.')
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''

  if (!name) {
    return badRequest('A segment name is required.')
  }

  // A segment stores no consent gate of its own — filtersToSegmentDefinition keeps only
  // the descriptive filters, and the gate is re-applied from the campaign's stream every
  // time the segment resolves. The stream here only decides which audience the member
  // count below describes.
  const stream = readConsentStream(body.stream)

  // Round-tripping through the parser strips anything unrecognised and forces the
  // consent / no-archived invariants, so only a sane definition is ever stored.
  const definition = filtersToSegmentDefinition(segmentDefinitionToFilters(body.definition, stream))

  try {
    const db = await createSupabaseServerClient()

    const { data, error } = await db
      .from('segments')
      .insert({
        name,
        description: typeof body.description === 'string' ? body.description.trim() : null,
        definition,
      })
      .select('*')
      .single()

    if (error) {
      // Unique index on lower(btrim(name)).
      if (error.code === '23505') {
        return NextResponse.json(
          { error: `A segment named "${name}" already exists.` },
          { status: 409, headers: { 'Cache-Control': 'private, no-store' } }
        )
      }

      throw new Error(error.message)
    }

    const members = await resolveSegmentMembers(db, definition, stream)

    return ok({ segment: data, memberCount: members.total, truncated: members.truncated })
  } catch (error) {
    return serverError(error, 'Could not create segment.')
  }
}

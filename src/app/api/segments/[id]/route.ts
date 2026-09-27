import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import type { SegmentRow } from '@/lib/db/types'
import { criteriaToDefinition, parseSegmentCriteria } from '@/lib/marketing/segmentCriteria'
import { describeLock, findLockingCampaigns, isSegmentLockError } from '@/lib/marketing/segmentLock'
import { resolveSegmentAudience } from '@/lib/marketing/segments'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * One segment: its definition, how many people it reaches on each stream, how many
 * manual decisions it carries, and whether a campaign currently locks it.
 */
export async function GET(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params

  try {
    const db = await createSupabaseServerClient()
    const { data: segment, error } = await db.from('segments').select('*').eq('id', id).maybeSingle()

    if (error) throw new Error(error.message)
    if (!segment) return notFound('Segment not found.')

    const count = (stream: 'newsletter' | 'programs') =>
      resolveSegmentAudience(db, { segmentId: id, definition: segment.definition, stream, page: 1, pageSize: 1 })

    const [newsletter, programs, lockedBy, overrides] = await Promise.all([
      count('newsletter'),
      count('programs'),
      findLockingCampaigns(db, id),
      db.from('segment_overrides').select('mode').eq('segment_id', id).limit(5000),
    ])

    if (overrides.error) throw new Error(overrides.error.message)

    const modes = (overrides.data ?? []).map((row) => row.mode)

    return ok({
      segment,
      counts: { newsletter: newsletter.total, programs: programs.total },
      overrides: {
        included: modes.filter((mode) => mode === 'include').length,
        excluded: modes.filter((mode) => mode === 'exclude').length,
      },
      lockedBy,
    })
  } catch (error) {
    return serverError(error, 'Could not load the segment.')
  }
}

/**
 * Renames a segment or changes its criteria.
 *
 * Refused with 409 while a campaign using it is approved or sending. The check here
 * names the campaign; the database trigger is what actually guarantees it.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  const patch: Partial<SegmentRow> = {}

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return badRequest('A segment name is required.')
    patch.name = name
  }

  if (body.description !== undefined) {
    patch.description = typeof body.description === 'string' ? body.description.trim() || null : null
  }

  if (body.definition !== undefined) {
    // Round-tripped through the parser, so only recognised criteria are stored.
    patch.definition = criteriaToDefinition(parseSegmentCriteria(body.definition))
  }

  if (Object.keys(patch).length === 0) return badRequest('Nothing to update.')

  try {
    const db = await createSupabaseServerClient()
    const lockedBy = await findLockingCampaigns(db, id)

    if (lockedBy.length > 0) return conflict(describeLock(lockedBy))

    const { data, error } = await db
      .from('segments')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (isSegmentLockError(error)) return conflict(error?.message ?? 'The segment is locked.')
    if (error?.code === '23505') {
      return NextResponse.json(
        { error: `A segment named "${patch.name}" already exists.` },
        { status: 409, headers: NO_STORE }
      )
    }
    if (error) throw new Error(error.message)
    if (!data) return notFound('Segment not found.')

    return ok({ segment: data })
  } catch (error) {
    return serverError(error, 'Could not update the segment.')
  }
}

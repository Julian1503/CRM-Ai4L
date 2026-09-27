import type { NextRequest, NextResponse } from 'next/server'

import { notFound, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { readConsentStream } from '@/lib/marketing/consentStream'
import { resolveSegmentAudience } from '@/lib/marketing/segments'
import { buildPageMeta, readPageParams } from '@/lib/pagination'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * Who is in a segment right now, one page at a time.
 *
 * `stream` picks the consent the list is counted against, because membership depends on
 * it: the same criteria reach different people for the newsletter and for courses.
 * `q` narrows the page and never widens it. Rows added by hand carry `is_included`.
 */
export async function GET(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const search = request.nextUrl.searchParams
  const pageParams = readPageParams(search, 25)

  try {
    const db = await createSupabaseServerClient()
    const { data: segment, error } = await db
      .from('segments')
      .select('definition')
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!segment) return notFound('Segment not found.')

    const page = await resolveSegmentAudience(db, {
      segmentId: id,
      definition: segment.definition,
      stream: readConsentStream(search.get('stream')),
      search: search.get('q'),
      ...pageParams,
    })

    const organisations = await organisationNames(
      db,
      page.members.map((member) => member.organisation_id)
    )

    return ok({
      members: page.members.map((member) => ({
        ...member,
        organisation: member.organisation_id ? (organisations.get(member.organisation_id) ?? null) : null,
      })),
      truncated: page.truncated,
      ...buildPageMeta(pageParams, page.total),
    })
  } catch (error) {
    return serverError(error, 'Could not load the segment members.')
  }
}

/** Names for one page's organisations: at most a page of ids, so one bounded read. */
async function organisationNames(
  db: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ids: Array<string | null>
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]

  if (unique.length === 0) return new Map()

  const { data } = await db.from('organisations').select('id, name').in('id', unique)

  return new Map((data ?? []).map((row) => [row.id, row.name]))
}

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { duplicateJobTypeMessage, validateJobTypeName } from '@/lib/contacts/jobTypes'
import { escapeLikePattern } from '@/lib/contacts/query'
import { buildPageMeta, getPageRange, readPageParams, readTrimmed } from '@/lib/pagination'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * The job-type catalogue, searchable and paginated.
 *
 * `?q=` matches anywhere in the name, case-insensitively. Bounded like every list: the
 * catalogue is small today, but an unbounded read stops at PostgREST's cap in silence.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const params = request.nextUrl.searchParams
  const pageParams = readPageParams(params)
  const { from, to } = getPageRange(pageParams)
  const term = readTrimmed(params, 'q')

  try {
    const db = await createSupabaseServerClient()
    let query = db
      .from('job_types')
      .select('id, name', { count: 'exact' })
      .order('name', { ascending: true })
      .order('id', { ascending: true })

    if (term) {
      query = query.ilike('name', `%${escapeLikePattern(term)}%`)
    }

    const { data, error, count } = await query.range(from, to)

    if (error) throw new Error(error.message)

    const meta = buildPageMeta(pageParams, count ?? 0)

    return ok({
      jobTypes: (data ?? []).map((row) => ({ id: row.id, name: row.name })),
      total: meta.total,
      page: meta.page,
      pageSize: meta.pageSize,
      hasMore: meta.hasMore,
    })
  } catch (error) {
    return serverError(error, 'Could not load job types.')
  }
}

/**
 * Adds a job type. A name the unique index already holds (ignoring case and surrounding
 * spaces) is a 409, not a silent reuse: the person typing it expected a new entry.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)
  if (!body) return badRequest('Expected a JSON object.')

  const validated = validateJobTypeName(body.name)
  if (!validated.ok) return badRequest(validated.error)

  try {
    const db = await createSupabaseServerClient()
    const { data, error } = await db
      .from('job_types')
      .insert({ name: validated.name })
      .select('id, name')
      .single()

    if (error) {
      if (error.code === '23505') return conflict(duplicateJobTypeMessage(validated.name))
      throw new Error(error.message)
    }

    return NextResponse.json(
      { jobType: { id: data.id, name: data.name } },
      { status: 201, headers: NO_STORE }
    )
  } catch (error) {
    return serverError(error, 'Could not create the job type.')
  }
}

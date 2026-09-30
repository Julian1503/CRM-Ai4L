import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { duplicateJobTypeMessage, isUuid, validateJobTypeName } from '@/lib/contacts/jobTypes'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * Renames a job type in place.
 *
 * The id is kept on purpose: contacts and segment definitions point at it, so a rename
 * is visible everywhere at once and nothing has to be re-assigned. There is no DELETE —
 * removing, merging and archiving job types are out of scope.
 *
 * Note for operators: `supabase/sync-job-types.js` matches EmailOctopus tags to job
 * types by exact name. Renaming one of the types it maps to makes that script report
 * the tag as unmatched (it changes nothing for those contacts) until its mapping is
 * updated.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  if (!isUuid(id)) return badRequest('Invalid job type id.')

  const body = await readJsonBody(request)
  if (!body) return badRequest('Expected a JSON object.')

  const validated = validateJobTypeName(body.name)
  if (!validated.ok) return badRequest(validated.error)

  try {
    const db = await createSupabaseServerClient()
    const { data, error } = await db
      .from('job_types')
      .update({ name: validated.name })
      .eq('id', id)
      .select('id, name')
      .maybeSingle()

    if (error) {
      if (error.code === '23505') return conflict(duplicateJobTypeMessage(validated.name))
      throw new Error(error.message)
    }

    if (!data) return notFound('Job type not found.')

    return ok({ jobType: { id: data.id, name: data.name } })
  } catch (error) {
    return serverError(error, 'Could not rename the job type.')
  }
}

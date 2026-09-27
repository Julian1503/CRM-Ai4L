import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import {
  badRequest,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { newsletterTemplateProblem } from '@/lib/marketing/schedules/templateCheck'
import { parseScheduleInput } from '@/lib/marketing/schedules/validate'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Edits, pauses/resumes (`isActive`) or archives (`archived`) a schedule.
 *
 * No DELETE: campaigns it drafted reference it, and archiving retires it just as well.
 * Changes apply from the next run; campaigns already drafted keep what they were given.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  try {
    const db = await createSupabaseServerClient()
    const { data: existing, error: loadError } = await db
      .from('newsletter_schedules')
      .select('frequency, timezone')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!existing) return notFound('Schedule not found.')

    // A new first date is checked against the frequency and zone it will run with,
    // including the stored ones when this request does not change them.
    const movesNextRun = body.firstRunDate !== undefined || body.sendTime !== undefined
    const parsed = parseScheduleInput(
      movesNextRun ? { frequency: existing.frequency, timezone: existing.timezone, ...body } : body,
      'update'
    )

    if (!parsed.ok) return badRequest(parsed.error)

    if (parsed.value.template_id) {
      const problem = await newsletterTemplateProblem(db, parsed.value.template_id)
      if (problem) return badRequest(problem)
    }

    const { data, error } = await db
      .from('newsletter_schedules')
      .update({ ...parsed.value, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error?.code === '23505') {
      return NextResponse.json(
        { error: `A schedule named "${parsed.value.name}" already exists.` },
        { status: 409, headers: NO_STORE }
      )
    }
    if (error) throw new Error(error.message)
    if (!data) return notFound('Schedule not found.')

    return ok({ schedule: data })
  } catch (error) {
    return serverError(error, 'Could not update the newsletter schedule.')
  }
}

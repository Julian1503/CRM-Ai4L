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
import { scheduleLifecycle } from '@/lib/lifecycle/entityLifecycle'
import {
  isArchiveRuleError,
  lifecyclePatch,
  readLifecycleAction,
  refusal,
  type LifecycleAction,
} from '@/lib/lifecycle/lifecycle'
import { newsletterTemplateProblem } from '@/lib/marketing/schedules/templateCheck'
import { parseScheduleInput } from '@/lib/marketing/schedules/validate'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Edits or pauses/resumes (`isActive`) a schedule; or, on its own, archives, restores or
 * removes it (`{ archived: boolean }`, `{ removed: true }`).
 *
 * No DELETE: campaigns it drafted reference it, and removing is a soft delete. Restoring
 * is refused while its segment or template is archived — it would fail on every run.
 * Changes apply from the next run; campaigns already drafted keep what they were given.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  const lifecycle = readLifecycleAction(body)

  if (lifecycle.kind === 'invalid') return badRequest(lifecycle.error)
  if (lifecycle.kind !== 'none') return changeLifecycle(id, lifecycle.kind, guard.session.userId)

  try {
    const db = await createSupabaseServerClient()
    const { data: existing, error: loadError } = await db
      .from('newsletter_schedules')
      .select('frequency, timezone, removed_at')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!existing || existing.removed_at) return notFound('Schedule not found.')

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

    // Its segment is archived: chosen here, or archived while this schedule was.
    if (isArchiveRuleError(error)) {
      return NextResponse.json({ error: error?.message }, { status: 409, headers: NO_STORE })
    }
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

async function changeLifecycle(id: string, action: LifecycleAction, userId: string): Promise<NextResponse> {
  try {
    const db = await createSupabaseServerClient()
    const { data: schedule, error: loadError } = await db
      .from('newsletter_schedules')
      .select('id, name, archived_at, removed_at')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!schedule || schedule.removed_at) return notFound('Schedule not found.')

    const refused = refusal(action, scheduleLifecycle(schedule))

    if (refused) return conflict(refused)

    const { data, error } = await db
      .from('newsletter_schedules')
      .update({ ...lifecyclePatch(action, schedule, userId), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle()

    // Restoring onto a segment or template that has been archived since.
    if (isArchiveRuleError(error)) return conflict(error?.message ?? 'The schedule cannot be restored.')
    if (error?.code === '23505') {
      return conflict(`A schedule named "${schedule.name}" already exists. Rename that one before restoring this.`)
    }
    if (error) throw new Error(error.message)
    if (!data) return notFound('Schedule not found.')

    return ok({ schedule: data })
  } catch (error) {
    return serverError(error, 'Could not change the newsletter schedule.')
  }
}

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { badRequest, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { isArchiveRuleError } from '@/lib/lifecycle/lifecycle'
import { newsletterTemplateProblem } from '@/lib/marketing/schedules/templateCheck'
import { parseScheduleInput } from '@/lib/marketing/schedules/validate'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Recurring newsletters. See `src/lib/marketing/schedules/runDue.ts` for what a
 * schedule does when it comes due — it drafts and waits for approval; it never sends.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Schedules in next-run order. Archived ones only when asked. Few by nature. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const includeArchived = request.nextUrl.searchParams.get('includeArchived') === 'true'

  try {
    const db = await createSupabaseServerClient()
    let query = db
      .from('newsletter_schedules')
      .select('*')
      .order('next_run_at', { ascending: true })
      .limit(100)

    if (!includeArchived) query = query.is('archived_at', null)

    const { data, error } = await query

    if (error) throw new Error(error.message)

    return ok({ schedules: data ?? [] })
  } catch (error) {
    return serverError(error, 'Could not load newsletter schedules.')
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  const parsed = parseScheduleInput(body, 'create')

  if (!parsed.ok) return badRequest(parsed.error)

  try {
    const db = await createSupabaseServerClient()
    const problem = await newsletterTemplateProblem(db, parsed.value.template_id)

    if (problem) return badRequest(problem)

    const { data, error } = await db
      .from('newsletter_schedules')
      .insert({ ...parsed.value, created_by: guard.session.userId })
      .select('*')
      .single()

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

    return ok({ schedule: data })
  } catch (error) {
    return serverError(error, 'Could not create the newsletter schedule.')
  }
}

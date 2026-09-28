import type { NextRequest, NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { parseTopicInput } from '@/lib/marketing/schedules/validate'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string; topicId: string }> }

const USED_OR_MISSING = 'That topic does not exist or has already been used.'

/**
 * Edits or removes a queued topic.
 *
 * Only while unused: a used topic is the record of what an issue was about, and editing
 * it afterwards would rewrite that history. Removing is a soft delete — the row stays,
 * and a CHECK keeps a used topic from ever being removed or a removed one from being used.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id, topicId } = await params
  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  const parsed = parseTopicInput(body, 'update')

  if (!parsed.ok) return badRequest(parsed.error)

  try {
    const db = await createSupabaseServerClient()
    const { data, error } = await db
      .from('newsletter_topics')
      .update(parsed.value)
      .eq('id', topicId)
      .eq('schedule_id', id)
      .is('used_at', null)
      .is('removed_at', null)
      .select('*')
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return conflict(USED_OR_MISSING)

    return ok({ topic: data })
  } catch (error) {
    return serverError(error, 'Could not update the topic.')
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id, topicId } = await params

  try {
    const db = await createSupabaseServerClient()
    const { data, error } = await db
      .from('newsletter_topics')
      .update({ removed_at: new Date().toISOString(), removed_by: guard.session.userId })
      .eq('id', topicId)
      .eq('schedule_id', id)
      .is('used_at', null)
      .is('removed_at', null)
      .select('id')

    if (error) throw new Error(error.message)
    if ((data ?? []).length === 0) return conflict(USED_OR_MISSING)

    return ok({ deleted: topicId })
  } catch (error) {
    return serverError(error, 'Could not remove the topic.')
  }
}

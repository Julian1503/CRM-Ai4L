import type { NextRequest, NextResponse } from 'next/server'

import {
  badRequest,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { parseTopicInput } from '@/lib/marketing/schedules/validate'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** A schedule's topics: the queue first, in the order it will be used, then history. */
export async function GET(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params

  try {
    const db = await createSupabaseServerClient()
    const { data, error } = await db
      .from('newsletter_topics')
      .select('*')
      .eq('schedule_id', id)
      .order('used_at', { ascending: false, nullsFirst: true })
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(200)

    if (error) throw new Error(error.message)

    return ok({ topics: data ?? [] })
  } catch (error) {
    return serverError(error, 'Could not load topics.')
  }
}

/** Queues a topic. Without a position it goes to the back of the queue. */
export async function POST(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  const parsed = parseTopicInput(body, 'create')

  if (!parsed.ok) return badRequest(parsed.error)

  try {
    const db = await createSupabaseServerClient()
    const { data: schedule, error: scheduleError } = await db
      .from('newsletter_schedules')
      .select('id')
      .eq('id', id)
      .maybeSingle()

    if (scheduleError) throw new Error(scheduleError.message)
    if (!schedule) return notFound('Schedule not found.')

    const position = parsed.value.position ?? (await nextPosition(db, id))

    const { data, error } = await db
      .from('newsletter_topics')
      .insert({
        schedule_id: id,
        title: parsed.value.title,
        details: parsed.value.details ?? null,
        position,
      })
      .select('*')
      .single()

    if (error) throw new Error(error.message)

    return ok({ topic: data })
  } catch (error) {
    return serverError(error, 'Could not add the topic.')
  }
}

async function nextPosition(
  db: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  scheduleId: string
): Promise<number> {
  const { data } = await db
    .from('newsletter_topics')
    .select('position')
    .eq('schedule_id', scheduleId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (data?.position ?? 0) + 1
}

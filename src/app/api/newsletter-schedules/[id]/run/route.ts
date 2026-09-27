import type { NextRequest, NextResponse } from 'next/server'

import { conflict, notFound, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import type { NewsletterScheduleRow } from '@/lib/db/types'
import { createAnthropicClient, getAnthropicApiKey } from '@/lib/marketing/generateCampaign'
import { runScheduleNow } from '@/lib/marketing/schedules/runDue'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/** One generation, which routinely takes tens of seconds. */
export const maxDuration = 120

type RouteContext = { params: Promise<{ id: string }> }

/**
 * "Generate now": drafts today's issue immediately, to try a schedule out or for an
 * extra issue. Does not move the schedule's next run, and like the cron it stops at
 * review. Nothing is sent.
 */
export async function POST(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params

  try {
    const db = await createSupabaseServerClient()
    const { data: schedule, error } = await db
      .from('newsletter_schedules')
      .select('*')
      .eq('id', id)
      .is('archived_at', null)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!schedule) return notFound('Schedule not found.')

    const apiKey = getAnthropicApiKey()
    const report = await runScheduleNow(
      { db, messages: apiKey ? createAnthropicClient(apiKey).messages : null, now: new Date() },
      schedule as NewsletterScheduleRow
    )

    if (report.status === 'skipped') {
      return conflict('Today’s issue for this schedule already exists. Find it in the campaign list.')
    }

    if (report.status === 'failed') {
      return report.reason === 'template_unusable'
        ? conflict('This schedule’s template can no longer send a newsletter. Choose another template.')
        : serverError(new Error(report.reason ?? 'The run failed.'))
    }

    return ok({ run: report })
  } catch (error) {
    return serverError(error, 'Could not generate the newsletter.')
  }
}

import type { NextRequest, NextResponse } from 'next/server'

import { conflict, notFound, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { isUuid } from '@/lib/contacts/tags'
import { createAnthropicClient, getAnthropicApiKey } from '@/lib/marketing/generateCampaign'
import { OccurrenceRetryError } from '@/lib/marketing/schedules/occurrences'
import { retryAndRunOccurrence } from '@/lib/marketing/schedules/runDue'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/** One generation, which routinely takes tens of seconds. */
export const maxDuration = 120

type RouteContext = { params: Promise<{ occurrenceId: string }> }

/**
 * POST /api/newsletter-schedules/occurrences/[occurrenceId]/retry → { run }.
 * Puts a failed or skipped occurrence back in the queue and drafts it now, with the
 * member's own session. Like every schedule run it stops at review; nothing is sent.
 */
export async function POST(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { occurrenceId } = await params
  if (!isUuid(occurrenceId)) return notFound('Occurrence not found.')

  try {
    const apiKey = getAnthropicApiKey()
    const run = await retryAndRunOccurrence(
      {
        db: await createSupabaseServerClient(),
        messages: apiKey ? createAnthropicClient(apiKey).messages : null,
        now: new Date(),
      },
      occurrenceId
    )
    return ok({ run })
  } catch (error) {
    if (error instanceof OccurrenceRetryError) {
      return error.status === 404 ? notFound(error.message) : conflict(error.message)
    }
    return serverError(error, 'Could not retry the occurrence.')
  }
}

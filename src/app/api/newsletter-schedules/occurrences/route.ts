import type { NextResponse } from 'next/server'

import { ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { listAttentionOccurrences } from '@/lib/marketing/schedules/occurrences'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * GET /api/newsletter-schedules/occurrences → { occurrences }: the failed and skipped
 * occurrences (audit H12), newest first, so the schedule list can show them with their
 * reason and a Retry action.
 */
export async function GET(): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    return ok({ occurrences: await listAttentionOccurrences(await createSupabaseServerClient()) })
  } catch (error) {
    return serverError(error, 'Could not load the schedule occurrences.')
  }
}

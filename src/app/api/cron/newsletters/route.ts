import type { NextRequest, NextResponse } from 'next/server'

import { ok, serverError, unauthorized } from '@/lib/api/responses'
import { isAuthorisedCronRequest } from '@/lib/auth/cron'
import { createAnthropicClient, getAnthropicApiKey } from '@/lib/marketing/generateCampaign'
import { runDueSchedules } from '@/lib/marketing/schedules/runDue'
import { recordCronRun } from '@/lib/health/cronRuns'
import { getAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/** A few schedules, each holding a model call for tens of seconds. */
export const maxDuration = 300

/**
 * Daily newsletter run, called by Vercel Cron (see vercel.json).
 *
 * Records each due schedule's occurrence(s) and advances it atomically, then drafts up
 * to a few queued occurrences (new, or retried after a failure) and leaves each in review —
 * see `src/lib/marketing/schedules/runDue.ts` and docs/CAMPAIGN_DELIVERY.md (H12).
 * Nothing is sent from here.
 *
 * Authenticated by CRON_SECRET — see src/lib/auth/cron.ts.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorisedCronRequest(request.headers.get('authorization'))) {
    return unauthorized()
  }

  // Each run is recorded for the integration health card; recording never fails the run.
  const startedAt = new Date()
  let db: ReturnType<typeof getAdminClient> | null = null

  try {
    db = getAdminClient()
    const apiKey = getAnthropicApiKey()
    const runs = await runDueSchedules({
      db,
      messages: apiKey ? createAnthropicClient(apiKey).messages : null,
      now: startedAt,
    })

    await recordCronRun(db, {
      job: 'newsletters',
      status: 'succeeded',
      startedAt,
      summary: { schedules: runs.length, failed: runs.filter((run) => run.status === 'failed').length },
    })

    return ok({ runs })
  } catch (error) {
    if (db) await recordCronRun(db, { job: 'newsletters', status: 'failed', startedAt, errorCode: 'run_failed' })
    return serverError(error, 'The newsletter run failed.')
  }
}

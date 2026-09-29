import type { NextRequest, NextResponse } from 'next/server'

import { ok, serverError, unauthorized } from '@/lib/api/responses'
import { isAuthorisedCronRequest } from '@/lib/auth/cron'
import { createAnthropicClient, getAnthropicApiKey } from '@/lib/marketing/generateCampaign'
import { runDueSchedules } from '@/lib/marketing/schedules/runDue'
import { getAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/** A few schedules, each holding a model call for tens of seconds. */
export const maxDuration = 300

/**
 * Daily newsletter run, called by Vercel Cron (see vercel.json).
 *
 * Drafts one campaign per due schedule and leaves it in review — see
 * `src/lib/marketing/schedules/runDue.ts`. Nothing is sent from here.
 *
 * Authenticated by CRON_SECRET — see src/lib/auth/cron.ts.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorisedCronRequest(request.headers.get('authorization'))) {
    return unauthorized()
  }

  try {
    const apiKey = getAnthropicApiKey()
    const runs = await runDueSchedules({
      db: getAdminClient(),
      messages: apiKey ? createAnthropicClient(apiKey).messages : null,
      now: new Date(),
    })

    return ok({ runs })
  } catch (error) {
    return serverError(error, 'The newsletter run failed.')
  }
}

import { createHash, timingSafeEqual } from 'node:crypto'

import type { NextRequest, NextResponse } from 'next/server'

import { ok, serverError, unauthorized } from '@/lib/api/responses'
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
 * Vercel sends `Authorization: Bearer $CRON_SECRET`. The proxy lets this path through
 * without a session (CRON_PATHS), so this check is the only gate: it fails closed when
 * the secret is unset, and compares digests so neither the length nor a prefix of the
 * secret leaks through timing.
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

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function isAuthorisedCronRequest(header: string | null): boolean {
  const secret = process.env.CRON_SECRET?.trim()

  if (!secret || !header) return false

  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`))
}

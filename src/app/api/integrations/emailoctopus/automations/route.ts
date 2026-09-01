import type { NextRequest, NextResponse } from 'next/server'

import { badRequest, conflict, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { loadEmailOctopusCredentials } from '@/lib/marketing/providers/credentials'
import { verifyAutomation, type AutomationCheck } from '@/lib/marketing/providers/emailOctopus'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Checks automation ids against EmailOctopus.
 *
 * EmailOctopus publishes no way to list automations, so an id can only arrive here by
 * being copied out of their UI by hand — and until this route existed, a mistyped or
 * stale one was undetectable until a send failed for every recipient in the segment,
 * with the reason buried in the ledger.
 *
 * POST rather than GET because the ids are sent in a body: there can be a page of them
 * (the campaign list checks all of its rows at once) and they do not belong in a URL
 * that proxies and browser history would keep.
 */

/** One provider round trip per id, so a page of campaigns cannot become a flood. */
const MAX_IDS = 25

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  const raw = Array.isArray(body.automationIds) ? body.automationIds : null

  if (!raw) return badRequest('automationIds must be an array.')

  // De-duplicated because several campaigns commonly share one automation, and each
  // duplicate would otherwise cost a provider request.
  const ids = [
    ...new Set(
      raw
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id !== '')
    ),
  ]

  if (ids.length === 0) return badRequest('No automation ids to check.')
  if (ids.length > MAX_IDS) return badRequest(`Check at most ${MAX_IDS} automations at a time.`)

  try {
    const db = await createSupabaseServerClient()
    const credentials = await loadEmailOctopusCredentials(db)

    if (!credentials) {
      return conflict('EmailOctopus credentials are not configured in Settings.')
    }

    // Sequential, not parallel: EmailOctopus rate-limits, and a burst of 25 would
    // answer 429 — which this route reports as `unknown`, i.e. no answer at all.
    const results: Record<string, AutomationCheck> = {}

    for (const automationId of ids) {
      results[automationId] = await verifyAutomation({
        apiKey: credentials.apiKey,
        automationId,
      })
    }

    return ok({ results })
  } catch (error) {
    return serverError(error, 'Could not check the EmailOctopus automations.')
  }
}

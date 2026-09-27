import type { NextRequest, NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { createAnthropicClient, getAnthropicApiKey } from '@/lib/marketing/generateCampaign'
import { generateForCampaign } from '@/lib/marketing/generateForCampaign'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Copy generation runs a frontier model with adaptive thinking, which routinely takes
 * tens of seconds. The platform default would cut it off mid-generation and bill for
 * the tokens anyway.
 */
export const maxDuration = 120

/**
 * Generates campaign copy for an existing draft.
 *
 * Deliberately not a create-and-generate: the campaign, its segment and its provider
 * automation are set up first, and generation fills in the copy. That ordering is what
 * lets the prompt describe a real audience — the model is told how many people will
 * receive this and how they were selected, which is the only audience information it
 * gets.
 *
 * The work is in `generateForCampaign`, shared with the newsletter scheduler. Generated
 * copy is a proposal; the approval gate is a separate, attributed endpoint and the
 * database trigger enforces it independently.
 */

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)
  const campaignId = typeof body?.campaignId === 'string' ? body.campaignId.trim() : ''

  if (!campaignId) {
    return badRequest('campaignId is required.')
  }

  const apiKey = getAnthropicApiKey()

  if (!apiKey) {
    // A configuration problem, not a request problem — say which knob is missing
    // rather than returning a generic failure the operator cannot act on.
    return serverError(
      new Error('ANTHROPIC_API_KEY is not configured, so copy cannot be generated.'),
      'Copy generation is not configured.'
    )
  }

  try {
    const db = await createSupabaseServerClient()
    const outcome = await generateForCampaign(db, createAnthropicClient(apiKey).messages, campaignId)

    if (!outcome.ok) {
      return outcome.reason === 'not_found' ? notFound(outcome.message) : conflict(outcome.message)
    }

    return ok({
      campaign: outcome.campaign,
      generation: outcome.generation,
      audience: outcome.audience,
    })
  } catch (error) {
    return serverError(error, 'Could not generate campaign copy.')
  }
}

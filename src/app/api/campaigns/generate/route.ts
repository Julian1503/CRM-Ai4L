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
import {
  createAnthropicClient,
  generateCampaignCopy,
  getAnthropicApiKey,
} from '@/lib/marketing/generateCampaign'
import { resolveSegmentMembers, segmentDefinitionToFilters } from '@/lib/marketing/segments'
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
 * Writes `merge_fields` and leaves `status` alone. Generated copy is a proposal; the
 * approval gate is a separate, attributed endpoint and the database trigger enforces
 * it independently.
 */

/** Statuses whose copy may still be rewritten. */
const EDITABLE_STATUSES = new Set(['draft', 'in_review', 'failed'])

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

    const { data: campaign, error: loadError } = await db
      .from('campaigns')
      .select('id, name, status, notes, segment_id, consent_stream, segment:segments(name, description, definition)')
      .eq('id', campaignId)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!campaign) return notFound('Campaign not found.')

    if (!EDITABLE_STATUSES.has(campaign.status)) {
      // Regenerating an approved campaign would swap the copy out from under the
      // person who approved it, leaving the approval attributed to text they never saw.
      return conflict(
        `A campaign in "${campaign.status}" cannot be rewritten. Move it back to draft first.`
      )
    }

    const segment = (campaign as unknown as {
      segment: { name: string; description: string | null; definition: unknown } | null
    }).segment

    if (!campaign.segment_id || !segment) {
      return conflict('Select a segment before generating copy — it defines the audience.')
    }

    const audience = await resolveSegmentMembers(db, segment.definition, campaign.consent_stream)

    if (audience.total === 0) {
      return conflict('This segment currently matches no contacts, so there is no audience to write for.')
    }

    const filters = segmentDefinitionToFilters(segment.definition, campaign.consent_stream)

    // Resolve the job type to its name. The segment stores a UUID, and handing the
    // model a UUID is worse than handing it nothing — it is noise that looks like
    // information, and "write to 3d02ab78-194e-481f" steers nothing.
    let jobTypeName: string | null = null

    if (filters.jobTypeId) {
      const { data: jobType } = await db
        .from('job_types')
        .select('name')
        .eq('id', filters.jobTypeId)
        .maybeSingle()

      jobTypeName = jobType?.name ?? null
    }

    const result = await generateCampaignCopy(
      createAnthropicClient(apiKey).messages,
      {
        campaignName: campaign.name,
        notes: campaign.notes,
        audience: {
          segmentName: segment.name,
          segmentDescription: segment.description,
          size: audience.total,
          jobType: jobTypeName,
          state: filters.state,
          status: filters.status,
          search: filters.q,
        },
      }
    )

    if (!result.ok) {
      return serverError(new Error(result.error), 'Could not generate campaign copy.')
    }

    // Replaces `merge_fields` outright rather than merging: the generated copy is the
    // whole contract, and a leftover value from a previous generation would merge into
    // the template beside the new copy without anything flagging the mismatch. The
    // booking link is not lost by this — it is added per recipient at send time.
    //
    // Status drops back to `draft` on purpose. Rewriting copy that was already in
    // review invalidates the review, and the reviewer should see the new text as new.
    const { data: updated, error: saveError } = await db
      .from('campaigns')
      .update({
        merge_fields: result.copy,
        subject: result.copy.Headline ?? null,
        status: 'draft',
      })
      .eq('id', campaignId)
      .eq('status', campaign.status)
      .select('*')
      .single()

    if (saveError) throw new Error(saveError.message)

    return ok({
      campaign: updated,
      generation: { attempts: result.attempts, usage: result.usage },
      audience: { size: audience.total, truncated: audience.truncated },
    })
  } catch (error) {
    return serverError(error, 'Could not generate campaign copy.')
  }
}

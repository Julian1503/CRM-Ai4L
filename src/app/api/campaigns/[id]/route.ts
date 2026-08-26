import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { canTransition } from '@/lib/marketing/campaignStatus'
import { validateCampaignCopy } from '@/lib/marketing/mergeFields'
import type { CampaignRow, CampaignStatus } from '@/lib/db/types'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * Status changes this endpoint will make.
 *
 * Approval and sending are deliberately excluded — they have dedicated routes that
 * attribute the approver and guard the irreversible step. Allowing them here would let
 * a generic edit request smuggle a campaign into 'approved'.
 */
const PATCHABLE_STATUSES: CampaignStatus[] = ['draft', 'in_review']

export async function GET(
  _request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params

  try {
    const db = await createSupabaseServerClient()
    const { data, error } = await db
      .from('campaigns')
      .select('*, segment:segments(name, definition)')
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return notFound('Campaign not found.')

    return ok({ campaign: data })
  } catch (error) {
    return serverError(error, 'Could not load campaign.')
  }
}

/** Updates campaign details, and moves it between draft and review. */
export async function PATCH(
  request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const body = await readJsonBody(request)

  if (!body) {
    return badRequest('Expected a JSON object.')
  }

  try {
    const db = await createSupabaseServerClient()

    const { data: existing, error: loadError } = await db
      .from('campaigns')
      .select('id, status')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!existing) return notFound('Campaign not found.')

    const updates: Partial<CampaignRow> = {}

    if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim()
    if (typeof body.segmentId === 'string') updates.segment_id = body.segmentId || null
    if (typeof body.subject === 'string') updates.subject = body.subject.trim() || null
    if (typeof body.notes === 'string') updates.notes = body.notes.trim() || null
    if (typeof body.providerAutomationId === 'string') {
      updates.provider_automation_id = body.providerAutomationId.trim() || null
    }

    // Human edits go through the same gate as generated copy. An operator retyping a
    // headline can overrun the template exactly like the model can, and the failure
    // looks identical at send time — so the length caps and the reserved-field rule
    // are enforced here, not only on the generation path.
    if (body.mergeFields !== undefined) {
      const validation = validateCampaignCopy(body.mergeFields)

      if (!validation.ok) {
        return badRequest(validation.errors.join(' '))
      }

      updates.merge_fields = validation.value
    }

    if (typeof body.status === 'string') {
      const next = body.status as CampaignStatus

      if (!PATCHABLE_STATUSES.includes(next)) {
        return conflict(
          `"${next}" cannot be set here. Use the approve or send endpoint instead.`
        )
      }

      if (!canTransition(existing.status, next)) {
        return conflict(`A campaign in "${existing.status}" cannot move to "${next}".`)
      }

      // `sent -> draft` is a legal transition, but only the reopen endpoint may perform
      // it: that is where the send run advances. Doing it here would leave the campaign
      // pointing at a ledger that is already complete, and the next send would find
      // nothing pending and declare itself finished without emailing anybody.
      if (existing.status === 'sent') {
        return conflict(
          'Use the re-send endpoint to re-open a campaign that has already been sent.'
        )
      }

      updates.status = next
    }

    const changesCampaignDetails = [
      'name',
      'segment_id',
      'subject',
      'notes',
      'provider_automation_id',
      'merge_fields',
    ].some((key) => key in updates)
    const resultingStatus = updates.status ?? existing.status

    if (changesCampaignDetails && !['draft', 'failed'].includes(resultingStatus)) {
      return conflict('Return this campaign to draft before changing its content or settings.')
    }

    if (Object.keys(updates).length === 0) {
      return badRequest('No supported fields to update.')
    }

    updates.updated_at = new Date().toISOString()

    const { data, error } = await db
      .from('campaigns')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw new Error(error.message)

    return ok({ campaign: data })
  } catch (error) {
    return serverError(error, 'Could not update campaign.')
  }
}

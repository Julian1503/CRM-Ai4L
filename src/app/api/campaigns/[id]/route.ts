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
import { campaignLifecycle } from '@/lib/lifecycle/entityLifecycle'
import {
  isArchiveRuleError,
  lifecyclePatch,
  readLifecycleAction,
  refusal,
  type LifecycleAction,
} from '@/lib/lifecycle/lifecycle'
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
    if (!data || data.removed_at) return notFound('Campaign not found.')

    return ok({ campaign: data, lifecycle: campaignLifecycle(data) })
  } catch (error) {
    return serverError(error, 'Could not load campaign.')
  }
}

/**
 * Updates campaign details, and moves it between draft and review; or, on its own,
 * archives, restores or removes it (`{ archived: boolean }`, `{ removed: true }`).
 *
 * An archived campaign is frozen until it is restored, and an approved or sending one
 * cannot be archived. The database triggers in 20260930000000 guarantee both.
 */
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

  const lifecycle = readLifecycleAction(body)

  if (lifecycle.kind === 'invalid') return badRequest(lifecycle.error)
  if (lifecycle.kind !== 'none') return changeLifecycle(id, lifecycle.kind, guard.session.userId)

  try {
    const db = await createSupabaseServerClient()

    const { data: existing, error: loadError } = await db
      .from('campaigns')
      .select('id, status, consent_stream, archived_at, removed_at')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!existing || existing.removed_at) return notFound('Campaign not found.')
    if (existing.archived_at) return conflict('This campaign is archived. Restore it before changing it.')

    const updates: Partial<CampaignRow> = {}

    if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim()
    if (typeof body.segmentId === 'string') updates.segment_id = body.segmentId || null
    if (typeof body.subject === 'string') updates.subject = body.subject.trim() || null
    if (typeof body.notes === 'string') updates.notes = body.notes.trim() || null
    if (typeof body.providerAutomationId === 'string') {
      updates.provider_automation_id = body.providerAutomationId.trim() || null
    }

    // The stream was frozen when the campaign was created. An automation registered
    // for the other stream carries that stream's copy, so pointing this campaign at it
    // would send, say, a course invitation to people who only agreed to the newsletter.
    // An unregistered id cannot be checked and is allowed, as it is at creation.
    if (updates.provider_automation_id) {
      const { data: registered, error: templateError } = await db
        .from('campaign_templates')
        .select('consent_stream')
        .eq('provider_automation_id', updates.provider_automation_id)
        .is('archived_at', null)

      if (templateError) throw new Error(templateError.message)

      if ((registered ?? []).some((row) => row.consent_stream !== existing.consent_stream)) {
        return conflict(
          'That automation belongs to a template for the other consent stream. ' +
            'Create a new campaign from that template instead.'
        )
      }
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

    // Optimistic concurrency (audit H6): an editor who loaded revision N may only write
    // over revision N. Optional for older clients; the database still refuses content
    // changes outside draft either way.
    const expectedRevision = body.expectedRevision
    if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision))) {
      return badRequest('expectedRevision must be an integer.')
    }

    updates.updated_at = new Date().toISOString()

    let query = db.from('campaigns').update(updates).eq('id', id).eq('status', existing.status)
    if (typeof expectedRevision === 'number') query = query.eq('revision', expectedRevision)

    const { data, error } = await query.select('*').maybeSingle()

    // An archived segment, chosen here or archived since.
    if (isArchiveRuleError(error)) return conflict(error?.message ?? 'That segment is archived.')
    if (error?.code === 'CRM03') return conflict(error.message)
    if (error) throw new Error(error.message)
    if (!data) {
      return conflict('Someone else changed this campaign while you were editing. Reload to see their changes.')
    }

    return ok({ campaign: data })
  } catch (error) {
    return serverError(error, 'Could not update campaign.')
  }
}

async function changeLifecycle(id: string, action: LifecycleAction, userId: string): Promise<NextResponse> {
  try {
    const db = await createSupabaseServerClient()
    const { data: campaign, error: loadError } = await db
      .from('campaigns')
      .select('id, status, archived_at, removed_at')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!campaign || campaign.removed_at) return notFound('Campaign not found.')

    const refused = refusal(action, campaignLifecycle(campaign))

    if (refused) return conflict(refused)

    const { data, error } = await db
      .from('campaigns')
      .update({ ...lifecyclePatch(action, campaign, userId), updated_at: new Date().toISOString() })
      .eq('id', id)
      // Conditioned on the status it was checked at, so an approval landing in between
      // is not archived out from under the send.
      .eq('status', campaign.status)
      .select('*')
      .maybeSingle()

    // Restoring a draft whose segment has since been archived, or a race the trigger caught.
    if (isArchiveRuleError(error)) return conflict(error?.message ?? 'The campaign cannot change right now.')
    // Restoring a scheduled issue whose date has been drafted again since.
    if (error?.code === '23505') {
      return conflict('Another issue of this newsletter already exists for the same date. Archive that one first.')
    }
    if (error) throw new Error(error.message)
    if (!data) return conflict('This campaign changed while you were looking at it. Reload and try again.')

    return ok({ campaign: data })
  } catch (error) {
    return serverError(error, 'Could not change the campaign.')
  }
}

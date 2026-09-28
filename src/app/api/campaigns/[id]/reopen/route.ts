import type { NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { isArchiveRuleError } from '@/lib/lifecycle/lifecycle'
import { canReopen } from '@/lib/marketing/campaignStatus'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * Re-opens a sent campaign so it can be sent again.
 *
 * Returns it to `draft` and starts a new run. Two deliberate choices:
 *
 * - **Draft, not approved.** The segment resolves live, so the audience of a second
 *   send is whoever matches *now* — different people from last time. Re-approving is
 *   the point of the approval gate, and skipping it because "this campaign was already
 *   approved once" would approve a send to contacts nobody has seen.
 * - **A new run rather than a cleared ledger.** `campaign_sends` is the record of who
 *   was emailed and what happened to them. Deleting it to make room for a second send
 *   would destroy the audit trail — including the evidence that a send went only to
 *   subscribed contacts, which is the Spam Act exposure recorded in PLAN.md.
 */
export async function POST(
  _request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params

  if (!id) {
    return badRequest('Campaign id is required.')
  }

  try {
    const db = await createSupabaseServerClient()

    const { data: campaign, error: loadError } = await db
      .from('campaigns')
      .select('id, status, send_run, archived_at, removed_at')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!campaign || campaign.removed_at) return notFound('Campaign not found.')
    if (campaign.archived_at) return conflict('This campaign is archived. Restore it before re-sending it.')

    if (!canReopen(campaign.status)) {
      return conflict(
        `Only a campaign that finished sending can be re-sent. This one is "${campaign.status}".`
      )
    }

    const nextRun = (campaign.send_run ?? 1) + 1

    const { data: reopened, error: reopenError } = await db
      .from('campaigns')
      .update({
        status: 'draft',
        send_run: nextRun,
        // The previous run's timestamps describe a send that is over. Cleared so the
        // new run does not inherit a start and a completion it never had.
        started_at: null,
        completed_at: null,
        approved_at: null,
        approved_by: null,
      })
      .eq('id', campaign.id)
      // Conditioned on the status it was read at, so a double click cannot advance the
      // run counter twice and strand an empty run in the ledger.
      .eq('status', 'sent')
      .select('id, status, send_run')
      .maybeSingle()

    // Its segment was archived since it went out.
    if (isArchiveRuleError(reopenError)) return conflict(reopenError?.message ?? 'The segment is archived.')
    if (reopenError) throw new Error(reopenError.message)
    if (!reopened) return conflict('This campaign was already re-opened.')

    return ok({ campaign: reopened })
  } catch (error) {
    return serverError(error, 'Could not re-open campaign.')
  }
}

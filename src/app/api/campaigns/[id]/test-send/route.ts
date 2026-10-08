import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { badRequest, conflict, notFound, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { resolveSendContent } from '@/lib/marketing/campaignContent'
import { loadEmailOctopusCredentials } from '@/lib/marketing/providers/credentials'
import { createEmailOctopusProvider } from '@/lib/marketing/providers/emailOctopus'
import { listTestSends, readTestRecipients, readTestStatus, sendCampaignTest } from '@/lib/marketing/testSend'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Test sends for one campaign (UX plan P0.2). Not a delivery: nothing here touches the
 * campaign's runs, recipient ledger, bookings, status or approval.
 *
 * GET  -> { enabled, recipients, testSends, status: { lastSuccessful, currentRevisionTested } }
 *         `recipients` is the server allowlist (CAMPAIGN_TEST_RECIPIENTS) the UI picks from.
 * POST { recipient, revision } -> { testSend, note }
 *         recipient must be on the allowlist; revision is the one on screen.
 */
export async function GET(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params

  try {
    const db = await createSupabaseServerClient()
    const { data: campaign, error } = await db
      .from('campaigns')
      .select('id, revision, merge_fields, content_snapshot_id, removed_at')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!campaign || campaign.removed_at) return notFound('Campaign not found.')

    const content = campaign.content_snapshot_id ? await resolveSendContent(db, campaign) : null
    const recipients = readTestRecipients()

    return ok({
      enabled: recipients.length > 0,
      recipients,
      revision: campaign.revision,
      testSends: await listTestSends(db, id),
      status: await readTestStatus(db, campaign, content?.contentHash ?? null),
    })
  } catch (error) {
    return serverError(error, 'Could not load test sends.')
  }
}

export async function POST(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const allowlist = readTestRecipients()
  if (allowlist.length === 0) {
    return NextResponse.json(
      { error: 'Test sends are not set up. Add CAMPAIGN_TEST_RECIPIENTS to the server environment.', code: 'feature_disabled' },
      { status: 404, headers: NO_STORE }
    )
  }

  const { id } = await params
  const body = await readJsonBody(request)
  const recipient = typeof body?.recipient === 'string' ? body.recipient : ''
  const revision = body?.revision
  if (!recipient) return badRequest('Choose a test recipient.')
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    return badRequest('Send the revision being tested as { revision }.')
  }

  try {
    const credentials = await loadEmailOctopusCredentials()
    if (!credentials) return conflict('EmailOctopus credentials are not configured in Settings.')

    const db = await createSupabaseServerClient()
    const outcome = await sendCampaignTest(db, id, {
      recipient,
      revision,
      allowlist,
      provider: createEmailOctopusProvider(credentials),
      baseUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() || request.nextUrl.origin,
    })

    if (outcome.kind === 'done') return ok({ testSend: outcome.testSend, note: outcome.note })
    if (outcome.kind === 'not_found') return notFound(outcome.message)
    if (outcome.kind === 'bad_request') return badRequest(outcome.message)
    if (outcome.kind === 'rate_limited') {
      return NextResponse.json({ error: outcome.message, code: 'rate_limited' }, { status: 429, headers: NO_STORE })
    }
    return conflict(outcome.message)
  } catch (error) {
    return serverError(error, 'Could not send the test.')
  }
}

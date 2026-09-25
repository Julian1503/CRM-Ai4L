import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import { badRequest, notFound, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { buildPageMeta, getPageRange, readPageParams } from '@/lib/pagination'
import { resolveSegmentPage } from '@/lib/marketing/segments'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

type Recipient = {
  contactId: string
  firstName: string
  lastName: string
  email: string
  /** `planned` for an audience that has not been sent to yet. */
  status: 'planned' | 'pending' | 'sent' | 'failed' | 'skipped'
  error: string | null
}

type LedgerRow = {
  contact_id: string
  status: Recipient['status']
  error: string | null
  contact: { id: string; email: string; first_name: string; last_name: string } | null
}

/**
 * Who this campaign goes to, by name.
 *
 * Two sources, and which one answers is itself information:
 *
 * - **The ledger**, once a run exists. This is who was *actually* written to and what
 *   happened to each of them — a segment re-resolved after the fact would quietly
 *   answer a different question, because contacts unsubscribe and get archived.
 * - **The segment**, before that. A live resolution of who would receive it if it were
 *   sent now.
 *
 * Paged, because a segment can hold ten thousand people and this renders in a dialog.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params

  if (!id) {
    return badRequest('Campaign id is required.')
  }

  const pageParams = readPageParams(request.nextUrl.searchParams)

  try {
    const db = await createSupabaseServerClient()

    const { data: campaign, error: loadError } = await db
      .from('campaigns')
      .select('id, name, segment_id, send_run, consent_stream, segment:segments(name, definition)')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!campaign) return notFound('Campaign not found.')

    const run = campaign.send_run ?? 1
    const segment = campaign.segment as unknown as
      | { name: string; definition: Record<string, unknown> }
      | null

    const { from, to } = getPageRange(pageParams)

    const {
      data: ledger,
      error: ledgerError,
      count,
    } = await db
      .from('campaign_sends')
      .select('contact_id, status, error, contact:contacts(id, email, first_name, last_name)', {
        count: 'exact',
      })
      .eq('campaign_id', campaign.id)
      .eq('run', run)
      .order('status', { ascending: true })
      .range(from, to)

    if (ledgerError) throw new Error(ledgerError.message)

    const ledgerTotal = count ?? 0

    if (ledgerTotal > 0) {
      const recipients: Recipient[] = ((ledger ?? []) as unknown as LedgerRow[]).map((row) => ({
        contactId: row.contact_id,
        firstName: row.contact?.first_name ?? '',
        lastName: row.contact?.last_name ?? '',
        // A deleted contact leaves the ledger row behind on purpose: the send happened,
        // and the history must not disappear with the record.
        email: row.contact?.email ?? 'Contact removed',
        status: row.status,
        error: row.error,
      }))

      return ok({
        source: 'ledger',
        run,
        segmentName: segment?.name ?? null,
        truncated: false,
        recipients,
        ...buildPageMeta(pageParams, ledgerTotal),
      })
    }

    if (!campaign.segment_id || !segment) {
      return ok({
        source: 'segment',
        run,
        segmentName: null,
        truncated: false,
        recipients: [],
        ...buildPageMeta(pageParams, 0),
      })
    }

    const page = await resolveSegmentPage(
      db,
      segment.definition,
      campaign.consent_stream,
      pageParams
    )

    return ok({
      source: 'segment',
      run,
      segmentName: segment.name,
      // Surfaced so a capped audience is never mistaken for the whole one.
      truncated: page.truncated,
      recipients: page.members.map((member) => ({
        contactId: member.id,
        firstName: member.first_name,
        lastName: member.last_name,
        email: member.email,
        status: 'planned' as const,
        error: null,
      })),
      ...buildPageMeta(pageParams, page.total),
    })
  } catch (error) {
    return serverError(error, 'Could not load the campaign audience.')
  }
}

import type { NextRequest, NextResponse } from 'next/server'

import { badRequest, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { MAX_SUMMARY_BATCH, readCampaignSendSummaries } from '@/lib/marketing/sendStatus'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Send summaries for several campaigns in one request (audit A2): `?ids=a,b,c`.
 * Bounded, and read under the caller's RLS like every other campaign read.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const ids = (request.nextUrl.searchParams.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)

  if (ids.length === 0) return badRequest('Pass one or more campaign ids as ?ids=.')
  if (ids.length > MAX_SUMMARY_BATCH) return badRequest(`At most ${MAX_SUMMARY_BATCH} ids per request.`)
  if (!ids.every((id) => UUID.test(id))) return badRequest('Campaign ids must be UUIDs.')

  try {
    const db = await createSupabaseServerClient()
    const summaries = await readCampaignSendSummaries(db, ids)
    return ok({ summaries: Object.fromEntries(summaries) })
  } catch (error) {
    return serverError(error, 'Could not read send summaries.')
  }
}

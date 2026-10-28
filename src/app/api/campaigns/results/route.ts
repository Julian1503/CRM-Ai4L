import type { NextRequest, NextResponse } from 'next/server'

import { ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { readCampaignResults } from '@/lib/marketing/campaignResults'
import { buildPageMeta, readPageParams } from '@/lib/pagination'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const RESULTS_PAGE_SIZE = 25

/**
 * Campaigns that went out, newest send first, each with what the send ledger says
 * (sent, failed, skipped) and what recipients did next (opened the booking link, paid,
 * booked, cancelled). Read under the caller's RLS like every other campaign read.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const db = await createSupabaseServerClient()
    const page = readPageParams(request.nextUrl.searchParams, RESULTS_PAGE_SIZE)
    const { results, total } = await readCampaignResults(db, page)

    return ok({ results, ...buildPageMeta(page, total) })
  } catch (error) {
    return serverError(error, 'Could not load campaign results.')
  }
}

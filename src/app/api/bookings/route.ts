import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import { ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { parseBookingFilters } from '@/lib/booking/query'
import { countBookingsByStatus, fetchBookings } from '@/lib/booking/repository'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Lists consultation bookings, with a status breakdown of the whole funnel.
 *
 * This is the read side of a pipeline that previously had none: the Stripe and Calendly
 * webhooks have always written booking state, and nothing in the application ever read
 * it back. A booking that reached `paid` and stalled -- the exact shape of a Calendly
 * webhook outage -- was invisible.
 *
 * Uses the session-scoped client, not the service-role one. The bookings table grants
 * SELECT to `authenticated`, so RLS stays in force here; the service-role client is for
 * the sessionless webhook and public booking paths only.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const db = await createSupabaseServerClient()
    const filters = parseBookingFilters(request.nextUrl.searchParams)

    // The counts describe the whole funnel and the rows describe one page of it, so
    // they are independent queries rather than one derived from the other.
    const [{ rows, total }, counts] = await Promise.all([
      fetchBookings(db, filters),
      countBookingsByStatus(db),
    ])

    return ok({
      bookings: rows,
      counts,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      hasMore: filters.page * filters.pageSize < total,
    })
  } catch (error) {
    return serverError(error, 'Could not load bookings.')
  }
}

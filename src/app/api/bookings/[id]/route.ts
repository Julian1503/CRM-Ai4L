import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import { notFound, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { isUuid } from '@/lib/contacts/jobTypes'
import { fetchBookingDetail } from '@/lib/booking/queue'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * One booking for the detail drawer: the record, why it needs action, and its timeline
 * (UX plan P4.2). Read-only.
 *
 * Session client, so RLS applies to every table read. The token hash is never selected.
 * The id is checked to be a UUID before it reaches a filter expression.
 */
export async function GET(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  if (!isUuid(id)) return notFound('Booking not found.')

  try {
    const db = await createSupabaseServerClient()
    const detail = await fetchBookingDetail(db, id, Date.now())
    if (!detail) return notFound('Booking not found.')
    return ok(detail)
  } catch (error) {
    return serverError(error, 'Could not load this booking.')
  }
}

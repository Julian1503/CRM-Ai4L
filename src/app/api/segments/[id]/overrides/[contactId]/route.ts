import type { NextRequest, NextResponse } from 'next/server'

import { conflict, notFound, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { describeLock, findLockingCampaigns, isSegmentLockError } from '@/lib/marketing/segmentLock'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string; contactId: string }> }

/** Removes a manual decision: the person goes back to being in or out by the criteria. */
export async function DELETE(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id, contactId } = await params

  try {
    const db = await createSupabaseServerClient()
    const lockedBy = await findLockingCampaigns(db, id)

    if (lockedBy.length > 0) return conflict(describeLock(lockedBy))

    const { data, error } = await db
      .from('segment_overrides')
      .delete()
      .eq('segment_id', id)
      .eq('contact_id', contactId)
      .select('contact_id')

    if (isSegmentLockError(error)) return conflict(error?.message ?? 'The segment is locked.')
    if (error) throw new Error(error.message)
    if ((data ?? []).length === 0) return notFound('There is no manual decision for that contact.')

    return ok({ removed: contactId })
  } catch (error) {
    return serverError(error, 'Could not remove the manual decision.')
  }
}

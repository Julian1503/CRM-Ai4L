import type { NextResponse } from 'next/server'

import { ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { readAttentionCounts } from '@/lib/operations/attention'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/** Returns aggregate operational health without exposing delivery rows or contact data. */
export async function GET(): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const db = await createSupabaseServerClient()
    const { data, error } = await db.rpc('get_operations_summary')

    if (error) {
      throw new Error(`Could not aggregate operations: ${error.message}`)
    }

    if (!data) {
      throw new Error('Operations summary returned no data.')
    }

    return ok({ summary: { ...data, attention: await readAttentionCounts(db) } })
  } catch (error) {
    return serverError(error, 'Could not load operational health.')
  }
}

import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import { ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { parseContactFilters } from '@/lib/contacts/query'
import { fetchContacts } from '@/lib/contacts/repository'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Lists contacts for the current filters.
 *
 * `?includeArchived=true` switches to the archive view, which reads the base table and
 * returns *only* soft-deleted rows. Everything else reads the active_contacts view, so
 * archived contacts cannot leak into a normal listing.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const db = await createSupabaseServerClient()
    const filters = parseContactFilters(request.nextUrl.searchParams)
    const { rows, total } = await fetchContacts(db, filters)

    return ok({
      contacts: rows,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      hasMore: filters.page * filters.pageSize < total,
    })
  } catch (error) {
    return serverError(error, 'Could not load contacts.')
  }
}

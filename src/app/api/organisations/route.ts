import type { NextRequest, NextResponse } from 'next/server'

import { ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { listIndustries, listOrganisations, normaliseSearchTerm } from '@/lib/contacts/organisations'
import { readPageParams } from '@/lib/pagination'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Organisation options for the contact filters.
 *
 *   ?q=&page=&pageSize=      paginated organisations `{ organisations, total, ... }`
 *   ?facet=industry&q=       distinct industries `{ industries }`, sorted, at most 200
 *
 * Options come from the server rather than from the contacts on screen, which would
 * only ever offer the organisations of the current page.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const params = request.nextUrl.searchParams
  const q = normaliseSearchTerm(params.get('q'))

  try {
    const db = await createSupabaseServerClient()

    if (params.get('facet') === 'industry') {
      return ok({ industries: await listIndustries(db, q) })
    }

    const page = readPageParams(params)
    const { organisations, total } = await listOrganisations(db, { ...page, q })

    return ok({
      organisations,
      total,
      page: page.page,
      pageSize: page.pageSize,
      hasMore: page.page * page.pageSize < total,
    })
  } catch (error) {
    return serverError(error, 'Could not load organisations.')
  }
}

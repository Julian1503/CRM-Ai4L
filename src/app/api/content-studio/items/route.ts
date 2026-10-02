import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { createItem, listItems } from '@/lib/content-studio/repository'
import { json, readValidBody, runContentRoute } from '@/lib/content-studio/userRoute'
import { parseCreateItem } from '@/lib/content-studio/validation'
import { readPageParams } from '@/lib/pagination'

export const runtime = 'nodejs'

const MAX_SEARCH_LENGTH = 200

/** GET /api/content-studio/items?search=&status=active|archived&page=&pageSize= */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not load content items.', async ({ db }) => {
    const params = request.nextUrl.searchParams
    const search = params.get('search')?.trim().slice(0, MAX_SEARCH_LENGTH) || null
    const status = params.get('status') === 'archived' ? 'archived' : 'active'

    return json(await listItems(db, { ...readPageParams(params, 20), search, status }))
  })
}

/** POST /api/content-studio/items -> 201 { item } */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not create the content item.', async ({ db, session }) => {
    const body = await readValidBody(request, parseCreateItem)
    return json({ item: await createItem(db, session.userId, body) }, 201)
  })
}

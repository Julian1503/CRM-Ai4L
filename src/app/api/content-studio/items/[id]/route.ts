import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { ContentHttpError } from '@/lib/content-studio/errors'
import { getItem, updateItem } from '@/lib/content-studio/repository'
import { json, readRouteId, readValidBody, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'
import { parseUpdateItem } from '@/lib/content-studio/validation'

export const runtime = 'nodejs'

const NOT_FOUND = 'Content item not found.'

/** GET /api/content-studio/items/[id] -> { item } with variants, jobs and publications. */
export async function GET(_request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not load the content item.', async ({ db }) => {
    const item = await getItem(db, await readRouteId(context, NOT_FOUND))
    if (!item) throw new ContentHttpError(404, NOT_FOUND)
    return json({ item })
  })
}

/** PATCH /api/content-studio/items/[id] (title, brief, channels, archived) -> { item } */
export async function PATCH(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not update the content item.', async ({ db, session }) => {
    const id = await readRouteId(context, NOT_FOUND)
    const item = await updateItem(db, id, session.userId, await readValidBody(request, parseUpdateItem))
    if (!item) throw new ContentHttpError(404, NOT_FOUND)
    return json({ item })
  })
}

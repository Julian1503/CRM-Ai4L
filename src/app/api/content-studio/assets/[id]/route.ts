import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { updateAsset } from '@/lib/content-studio/assets'
import { ContentHttpError } from '@/lib/content-studio/errors'
import { json, readRouteId, readValidBody, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'
import { parseUpdateAsset } from '@/lib/content-studio/validation'

export const runtime = 'nodejs'

/** PATCH /api/content-studio/assets/[id] (altText, archived) -> { asset } */
export async function PATCH(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not update the image.', async ({ db, session }) => {
    const id = await readRouteId(context, 'Image not found.')
    const body = await readValidBody(request, parseUpdateAsset)
    const asset = await updateAsset(db, id, session.userId, body)
    if (!asset) throw new ContentHttpError(404, 'Image not found.')
    return json({ asset })
  })
}

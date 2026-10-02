import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { ContentHttpError } from '@/lib/content-studio/errors'
import { updateVariant } from '@/lib/content-studio/revisions'
import { json, readRouteId, readValidBody, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'
import { parseUpdateVariant } from '@/lib/content-studio/validation'

export const runtime = 'nodejs'

/** PATCH /api/content-studio/variants/[id] { archived } -> { variant }. Archive only; content changes are revisions. */
export async function PATCH(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not update the variant.', async ({ db, session }) => {
    const id = await readRouteId(context, 'Variant not found.')
    const variant = await updateVariant(db, id, session.userId, await readValidBody(request, parseUpdateVariant))
    if (!variant) throw new ContentHttpError(404, 'Variant not found.')
    return json({ variant })
  })
}

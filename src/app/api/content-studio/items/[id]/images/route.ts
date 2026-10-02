import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { ContentHttpError } from '@/lib/content-studio/errors'
import { enqueueImageGeneration } from '@/lib/content-studio/jobs'
import { findItemRow } from '@/lib/content-studio/repository'
import { json, readRouteId, readValidBody, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'
import { parseGenerateImages } from '@/lib/content-studio/validation'

export const runtime = 'nodejs'

/** POST /api/content-studio/items/[id]/images -> 202 { job }. Idempotent on idempotencyKey. */
export async function POST(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not queue the image generation.', async ({ db }) => {
    const item = await findItemRow(db, await readRouteId(context, 'Content item not found.'))
    if (!item) throw new ContentHttpError(404, 'Content item not found.')

    const body = await readValidBody(request, parseGenerateImages)
    return json({ job: await enqueueImageGeneration(db, item, body) }, 202)
  })
}

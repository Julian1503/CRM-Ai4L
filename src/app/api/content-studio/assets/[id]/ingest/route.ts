import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { findAssetRow } from '@/lib/content-studio/assets'
import { ContentHttpError } from '@/lib/content-studio/errors'
import { enqueueIngest } from '@/lib/content-studio/jobs'
import { json, readRouteId, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'

export const runtime = 'nodejs'

/** POST /api/content-studio/assets/[id]/ingest -> 202 { job }. One job per asset (key ingest:<assetId>). */
export async function POST(_request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not queue the image for processing.', async ({ db }) => {
    const asset = await findAssetRow(db, await readRouteId(context, 'Image not found.'))
    if (!asset) throw new ContentHttpError(404, 'Image not found.')
    return json({ job: await enqueueIngest(db, asset) }, 202)
  })
}

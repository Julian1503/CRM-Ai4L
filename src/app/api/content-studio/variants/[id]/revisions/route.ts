import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { saveRevision } from '@/lib/content-studio/revisions'
import { json, readRouteId, readValidBody, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'
import { parseSaveRevision } from '@/lib/content-studio/validation'

export const runtime = 'nodejs'

/** POST /api/content-studio/variants/[id]/revisions -> 201 { revision }; 409 stale_revision if the variant moved on. */
export async function POST(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not save the revision.', async ({ db }) => {
    const variantId = await readRouteId(context, 'Variant not found.')
    const body = await readValidBody(request, parseSaveRevision)
    return json({ revision: await saveRevision(db, variantId, body) }, 201)
  })
}

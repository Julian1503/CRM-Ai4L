import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { duplicateVariant } from '@/lib/content-studio/revisions'
import { json, readRouteId, readValidBody, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'
import { parseDuplicateVariant } from '@/lib/content-studio/validation'

export const runtime = 'nodejs'

/** POST /api/content-studio/variants/[id]/duplicate -> 201 { variant }. Idempotent on idempotencyKey. */
export async function POST(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not duplicate the variant.', async ({ db }) => {
    const variantId = await readRouteId(context, 'Variant not found.')
    const body = await readValidBody(request, parseDuplicateVariant)
    return json({ variant: await duplicateVariant(db, variantId, body) }, 201)
  })
}

import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { json, readRouteId, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'
import { exportVariant } from '@/lib/content-studio/variantExport'

export const runtime = 'nodejs'

/** GET /api/content-studio/variants/[id]/export -> { export: VariantExport } (text + short-lived image links). */
export async function GET(_request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not export the variant.', async ({ db }) => {
    const variantId = await readRouteId(context, 'Variant not found.')
    return json({ export: await exportVariant(db, variantId) })
  })
}

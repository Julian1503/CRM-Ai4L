import type { NextRequest, NextResponse } from 'next/server'

import { forbidden, requireSessionOr401 } from '@/lib/api/responses'
import { getBrandProfile, updateBrandProfile } from '@/lib/content-studio/brand'
import { json, readValidBody, runContentRoute } from '@/lib/content-studio/userRoute'
import { parseBrandUpdate } from '@/lib/content-studio/validation'

export const runtime = 'nodejs'

/** GET /api/content-studio/brand -> { brand, canEdit }. Every member reads it; canEdit is the session's role. */
export async function GET(): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not load the brand profile.', async ({ db, session }) => {
    return json({ brand: await getBrandProfile(db), canEdit: session.role === 'admin' })
  })
}

/**
 * PATCH /api/content-studio/brand -> { brand, canEdit: true }. Administrators only (403
 * otherwise; the database refuses anyone else too). Omitted fields keep their value.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response
  if (guard.session.role !== 'admin') return forbidden('Only an administrator can change the brand profile.')

  return runContentRoute(guard.session, 'Could not save the brand profile.', async ({ db }) => {
    const update = await readValidBody(request, parseBrandUpdate)
    return json({ brand: await updateBrandProfile(db, update), canEdit: true })
  })
}

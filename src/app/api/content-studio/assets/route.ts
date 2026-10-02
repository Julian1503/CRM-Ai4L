import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { isUuid } from '@/lib/contacts/tags'
import { createUpload, listAssets } from '@/lib/content-studio/assets'
import { json, readValidBody, runContentRoute } from '@/lib/content-studio/userRoute'
import { parseCreateUpload } from '@/lib/content-studio/validation'
import { readPageParams } from '@/lib/pagination'

export const runtime = 'nodejs'

/** GET /api/content-studio/assets?itemId=&status=active|archived&page=&pageSize= -> { assets, total } */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not load images.', async ({ db }) => {
    const params = request.nextUrl.searchParams
    const itemId = params.get('itemId')
    const status = params.get('status') === 'archived' ? 'archived' : 'active'

    return json(
      await listAssets(db, { ...readPageParams(params, 40), itemId: isUuid(itemId) ? itemId : null, status })
    )
  })
}

/**
 * POST /api/content-studio/assets -> 201 { asset, upload }. The browser uploads the bytes
 * to the signed URL, then asks for processing with POST /assets/[id]/ingest.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not prepare the upload.', async ({ db, session }) => {
    const body = await readValidBody(request, parseCreateUpload)
    return json(await createUpload(db, session.userId, body), 201)
  })
}

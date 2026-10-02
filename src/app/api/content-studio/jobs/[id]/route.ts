import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { ContentHttpError } from '@/lib/content-studio/errors'
import { getJob } from '@/lib/content-studio/jobs'
import { json, readRouteId, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'

export const runtime = 'nodejs'

/** GET /api/content-studio/jobs/[id] -> { job }. The UI polls this until a terminal status. */
export async function GET(_request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not load the job.', async ({ db }) => {
    const job = await getJob(db, await readRouteId(context, 'Job not found.'))
    if (!job) throw new ContentHttpError(404, 'Job not found.')
    return json({ job })
  })
}

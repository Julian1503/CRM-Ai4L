import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { cancelJob } from '@/lib/content-studio/jobs'
import { json, readRouteId, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'

export const runtime = 'nodejs'

/**
 * POST /api/content-studio/jobs/[id]/cancel -> { job }. A queued job is cancelled at once;
 * a running one stops before its next stage. It never undoes an external effect.
 */
export async function POST(_request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not cancel the job.', async ({ db }) => {
    return json({ job: await cancelJob(db, await readRouteId(context, 'Job not found.')) })
  })
}

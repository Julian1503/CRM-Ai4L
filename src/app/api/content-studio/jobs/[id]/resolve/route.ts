import type { NextRequest, NextResponse } from 'next/server'

import { requireSessionOr401 } from '@/lib/api/responses'
import { resolveJob } from '@/lib/content-studio/jobs'
import { json, readRouteId, readValidBody, runContentRoute, type IdContext } from '@/lib/content-studio/userRoute'
import { parseResolveJob } from '@/lib/content-studio/validation'

export const runtime = 'nodejs'

/** POST /api/content-studio/jobs/[id]/resolve -> { job }. Settles an uncertain job after a person checked the provider. */
export async function POST(request: NextRequest, context: IdContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  return runContentRoute(guard.session, 'Could not resolve the job.', async ({ db }) => {
    const id = await readRouteId(context, 'Job not found.')
    return json({ job: await resolveJob(db, id, await readValidBody(request, parseResolveJob)) })
  })
}

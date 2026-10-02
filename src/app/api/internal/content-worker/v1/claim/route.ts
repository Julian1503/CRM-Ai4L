import type { NextRequest, NextResponse } from 'next/server'

import { claimJobs, handleWorkerRequest } from '@/lib/content-studio/workerOps'
import { parseClaim } from '@/lib/content-studio/workerValidation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Worker protocol v1: claims up to `limit` queued jobs of the given kinds under a lease. See src/lib/content-studio/workerOps.ts. */
export function POST(request: NextRequest): Promise<NextResponse> {
  return handleWorkerRequest(request, parseClaim, claimJobs)
}

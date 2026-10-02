import type { NextRequest, NextResponse } from 'next/server'

import { jobContext, handleWorkerRequest } from '@/lib/content-studio/workerOps'
import { parseJobRef } from '@/lib/content-studio/workerValidation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Worker protocol v1: the job's context, built fresh for the lease holder (409 lease_lost otherwise). See src/lib/content-studio/workerOps.ts. */
export function POST(request: NextRequest): Promise<NextResponse> {
  return handleWorkerRequest(request, parseJobRef, jobContext)
}

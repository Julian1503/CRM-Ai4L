import type { NextRequest, NextResponse } from 'next/server'

import { heartbeat, handleWorkerRequest } from '@/lib/content-studio/workerOps'
import { parseJobRef } from '@/lib/content-studio/workerValidation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Worker protocol v1: extends the lease; answers ok, cancel_requested or lost. See src/lib/content-studio/workerOps.ts. */
export function POST(request: NextRequest): Promise<NextResponse> {
  return handleWorkerRequest(request, parseJobRef, heartbeat)
}

import type { NextRequest, NextResponse } from 'next/server'

import { checkpoint, handleWorkerRequest } from '@/lib/content-studio/workerOps'
import { parseCheckpoint } from '@/lib/content-studio/workerValidation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Worker protocol v1: persists intermediate ids for the lease holder. See src/lib/content-studio/workerOps.ts. */
export function POST(request: NextRequest): Promise<NextResponse> {
  return handleWorkerRequest(request, parseCheckpoint, checkpoint)
}

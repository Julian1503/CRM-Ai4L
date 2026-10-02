import type { NextRequest, NextResponse } from 'next/server'

import { beginDispatch, handleWorkerRequest } from '@/lib/content-studio/workerOps'
import { parseJobRef } from '@/lib/content-studio/workerValidation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Worker protocol v1: records that the external effect starts, after re-validating it (go, lost or refused). See src/lib/content-studio/workerOps.ts. */
export function POST(request: NextRequest): Promise<NextResponse> {
  return handleWorkerRequest(request, parseJobRef, beginDispatch)
}

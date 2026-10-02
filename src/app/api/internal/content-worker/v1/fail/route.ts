import type { NextRequest, NextResponse } from 'next/server'

import { failJob, handleWorkerRequest } from '@/lib/content-studio/workerOps'
import { parseFail } from '@/lib/content-studio/workerValidation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Worker protocol v1: records a failure as retry, failed or uncertain. See src/lib/content-studio/workerOps.ts. */
export function POST(request: NextRequest): Promise<NextResponse> {
  return handleWorkerRequest(request, parseFail, failJob)
}

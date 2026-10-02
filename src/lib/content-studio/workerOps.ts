import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

import type { Database } from '@/lib/db/types'
import { getAdminClient } from '@/lib/supabase/admin'

import { contentErrorResponse, ContentHttpError, errorResponse, throwIfDbError } from './errors'
import { isContentStudioEnabled } from './flags'
import type {
  ClaimedJob,
  JobInput,
  WorkerAckResponse,
  WorkerBeginDispatchResponse,
  WorkerCheckpointRequest,
  WorkerClaimRequest,
  WorkerClaimResponse,
  WorkerContextResponse,
  WorkerCompleteRequest,
  WorkerFailRequest,
  WorkerHeartbeatResponse,
  WorkerJobRef,
} from './types'
import { isRecord, type Body, type Parsed } from './validation'
import { authenticateWorkerRequest } from './workerAuth'
import { buildJobContext, findLeasedJob } from './workerContext'
import { validateJobResult } from './workerValidation'

/**
 * The CRM side of the worker protocol v1: one function per operation, each calling the
 * matching service-role SQL function, plus the shared request pipeline every internal
 * route uses (signature → JSON → validation → operation → response). The worker gets
 * no generic table access: only these operations, each bound to a job and its claim token.
 */

type Db = SupabaseClient<Database>

export const DEFAULT_LEASE_SECONDS = 120
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function claimJobs(admin: Db, request: WorkerClaimRequest): Promise<WorkerClaimResponse> {
  // The kill switch stops new work being picked up; running jobs still settle.
  if (!isContentStudioEnabled()) return { jobs: [] }

  const { data, error } = await admin.rpc('claim_content_jobs', {
    p_worker_id: request.workerId,
    p_kinds: request.kinds,
    p_limit: request.limit,
    p_lease_seconds: request.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
  })
  throwIfDbError(error)

  const rows = (data ?? []) as Database['public']['Functions']['claim_content_jobs']['Returns']
  const jobs: ClaimedJob[] = rows.map((row) => ({
    jobId: row.job_id,
    kind: row.kind,
    claimToken: row.claim_token,
    attempt: row.attempt,
    input: row.input as JobInput,
    checkpoint: isRecord(row.checkpoint) ? row.checkpoint : {},
  }))
  return { jobs }
}

export async function heartbeat(admin: Db, ref: WorkerJobRef & { leaseSeconds?: number }): Promise<WorkerHeartbeatResponse> {
  const { data, error } = await admin.rpc('heartbeat_content_job', {
    p_job_id: ref.jobId,
    p_token: ref.claimToken,
    p_lease_seconds: ref.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
  })
  throwIfDbError(error)
  return { state: data === 'ok' || data === 'cancel_requested' ? data : 'lost' }
}

export async function jobContext(admin: Db, ref: WorkerJobRef): Promise<WorkerContextResponse> {
  const context = await buildJobContext(admin, ref.jobId, ref.claimToken)
  if (!context) throw new ContentHttpError(409, 'The lease on this job is no longer held.', 'lease_lost')
  return { context }
}

export async function checkpoint(admin: Db, request: WorkerCheckpointRequest): Promise<WorkerAckResponse> {
  const { data, error } = await admin.rpc('checkpoint_content_job', {
    p_job_id: request.jobId,
    p_token: request.claimToken,
    p_checkpoint: request.checkpoint,
  })
  throwIfDbError(error)
  return { accepted: data === true }
}

export async function beginDispatch(admin: Db, ref: WorkerJobRef): Promise<WorkerBeginDispatchResponse> {
  const { data, error } = await admin.rpc('begin_content_dispatch', { p_job_id: ref.jobId, p_token: ref.claimToken })
  throwIfDbError(error)
  return { decision: data === 'go' || data === 'refused' ? data : 'lost' }
}

/** Validates the result against the job's kind, then applies it — only for the lease holder. */
export async function complete(admin: Db, request: WorkerCompleteRequest): Promise<WorkerAckResponse> {
  const job = await findLeasedJob(admin, request.jobId, request.claimToken)
  if (!job) return { accepted: false }

  const result = validateJobResult(job.kind, request.result)
  if (!result.ok) throw new ContentHttpError(400, result.error)

  const { data, error } = await admin.rpc('complete_content_job', {
    p_job_id: request.jobId,
    p_token: request.claimToken,
    p_result: result.value,
  })
  throwIfDbError(error)
  return { accepted: data === true }
}

export async function failJob(admin: Db, request: WorkerFailRequest): Promise<WorkerAckResponse> {
  const { data, error } = await admin.rpc('fail_content_job', {
    p_job_id: request.jobId,
    p_token: request.claimToken,
    p_outcome: request.outcome,
    p_error_code: request.errorCode,
    p_message: request.message,
    p_provider_request_id: request.providerRequestId ?? null,
  })
  throwIfDbError(error)
  return { accepted: data === true }
}

/**
 * The pipeline of every /api/internal/content-worker/v1 route. The signature is checked
 * over the exact bytes received, before anything is parsed.
 */
export async function handleWorkerRequest<T>(
  request: Request,
  parse: (body: Body) => Parsed<T>,
  run: (admin: Db, input: T) => Promise<unknown>
): Promise<NextResponse> {
  const auth = await authenticateWorkerRequest(request)
  if (!auth.ok) {
    if (auth.reason === 'secret_not_configured') return errorResponse(503, 'The content worker bridge is not configured.')
    if (auth.reason === 'body_too_large') return errorResponse(413, 'Request body too large.', 'body_too_large')
    return errorResponse(401, 'Invalid worker signature.', auth.reason)
  }

  let body: unknown
  try {
    body = JSON.parse(auth.rawBody)
  } catch {
    return errorResponse(400, 'Expected a JSON body.')
  }
  if (!isRecord(body)) return errorResponse(400, 'Expected a JSON object.')

  const parsed = parse(body)
  if (!parsed.ok) return errorResponse(400, parsed.error)

  try {
    return NextResponse.json(await run(getAdminClient(), parsed.value), { headers: NO_STORE })
  } catch (error) {
    return contentErrorResponse(error, 'The worker request failed.')
  }
}

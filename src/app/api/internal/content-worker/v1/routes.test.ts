/** @jest-environment node */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockAdmin = jest.fn()
const mockBuildJobContext = jest.fn()
const mockFindLeasedJob = jest.fn()

jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockAdmin() }))
jest.mock('@/lib/content-studio/workerContext', () => ({
  buildJobContext: (...args: unknown[]) => mockBuildJobContext(...args),
  findLeasedJob: (...args: unknown[]) => mockFindLeasedJob(...args),
}))

import { IDS, jobRow } from '@/lib/content-studio/testFixtures'
import { signWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@/lib/content-studio/workerAuth'

import { POST as beginDispatch } from './begin-dispatch/route'
import { POST as checkpoint } from './checkpoint/route'
import { POST as claim } from './claim/route'
import { POST as complete } from './complete/route'
import { POST as context } from './context/route'
import { POST as fail } from './fail/route'
import { POST as heartbeat } from './heartbeat/route'

const SECRET = 's'.repeat(40)
const ORIGIN = 'https://crm.example.com'
const BASE = '/api/internal/content-worker/v1'
const REF = { jobId: IDS.job, claimToken: IDS.token }
const ORIGINAL_ENV = process.env

type Handler = (request: NextRequest) => Promise<Response>

function signedRequest(op: string, body: unknown, options: { secret?: string; raw?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(body)
  const path = `${BASE}/${op}`
  const ts = Math.floor(Date.now() / 1000)
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    body: raw,
    headers: {
      [WORKER_TIMESTAMP_HEADER]: String(ts),
      [WORKER_SIGNATURE_HEADER]: signWorkerRequest(options.secret ?? SECRET, ts, 'POST', path, raw),
    },
  })
}

async function call(handler: Handler, op: string, body: unknown, options?: { secret?: string; raw?: string }) {
  const response = await handler(signedRequest(op, body, options))
  return { status: response.status, body: await response.json() }
}

function adminWithRpc(result: unknown) {
  const db = createDbMock(createQueryBuilderMock())
  db.rpc.mockResolvedValue(result)
  mockAdmin.mockReturnValue(db)
  return db
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...ORIGINAL_ENV, CONTENT_WORKER_SECRET: SECRET, CONTENT_STUDIO_ENABLED: 'true' }
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

describe('worker authentication', () => {
  const handlers: [string, Handler][] = [
    ['claim', claim],
    ['heartbeat', heartbeat],
    ['context', context],
    ['checkpoint', checkpoint],
    ['begin-dispatch', beginDispatch],
    ['complete', complete],
    ['fail', fail],
  ]

  it.each(handlers)('%s refuses a bad signature before touching the database', async (op, handler) => {
    const result = await call(handler, op, REF, { secret: 'x'.repeat(40) })

    expect(result).toEqual({ status: 401, body: { error: 'Invalid worker signature.', code: 'signature_mismatch' } })
    expect(mockAdmin).not.toHaveBeenCalled()
  })

  it('refuses an unsigned request', async () => {
    const response = await heartbeat(new NextRequest(`${ORIGIN}${BASE}/heartbeat`, { method: 'POST', body: '{}' }))
    expect(response.status).toBe(401)
  })

  it('fails closed with 503 when the secret is not configured', async () => {
    process.env = { ...ORIGINAL_ENV, CONTENT_WORKER_SECRET: '' }
    const result = await call(claim, 'claim', { workerId: 'w', kinds: ['ingest_asset'], limit: 1 })

    expect(result.status).toBe(503)
    expect(mockAdmin).not.toHaveBeenCalled()
  })

  it('answers 413 for a body over the cap, before touching the database', async () => {
    const huge = JSON.stringify({ ...REF, checkpoint: { blob: 'x'.repeat(600 * 1024) } })
    const result = await call(checkpoint, 'checkpoint', null, { raw: huge })

    expect(result).toEqual({ status: 413, body: { error: 'Request body too large.', code: 'body_too_large' } })
    expect(mockAdmin).not.toHaveBeenCalled()
  })

  it('refuses a signature made for another operation', async () => {
    const request = signedRequest('heartbeat', REF)
    const moved = new NextRequest(`${ORIGIN}${BASE}/complete`, { method: 'POST', body: JSON.stringify(REF), headers: request.headers })

    expect((await complete(moved)).status).toBe(401)
  })

  it('answers 400 for malformed JSON, non-objects and invalid bodies', async () => {
    expect((await call(heartbeat, 'heartbeat', null, { raw: '{nope' })).status).toBe(400)
    expect((await call(heartbeat, 'heartbeat', [1])).body).toEqual({ error: 'Expected a JSON object.' })
    expect((await call(heartbeat, 'heartbeat', { jobId: 'x' })).status).toBe(400)
    expect(mockAdmin).not.toHaveBeenCalled()
  })
})

describe('claim', () => {
  it('claims with the default lease and maps rows', async () => {
    const db = adminWithRpc({
      data: [{ job_id: IDS.job, kind: 'ingest_asset', claim_token: IDS.token, attempt: 1, input: { assetId: IDS.asset }, checkpoint: null }],
      error: null,
    })

    const result = await call(claim, 'claim', { workerId: 'w1', kinds: ['ingest_asset'], limit: 2 })

    expect(result).toEqual({
      status: 200,
      body: { jobs: [{ jobId: IDS.job, kind: 'ingest_asset', claimToken: IDS.token, attempt: 1, input: { assetId: IDS.asset }, checkpoint: {} }] },
    })
    expect(db.rpc).toHaveBeenCalledWith('claim_content_jobs', { p_worker_id: 'w1', p_kinds: ['ingest_asset'], p_limit: 2, p_lease_seconds: 120 })
  })

  it('claims nothing while the studio is switched off', async () => {
    process.env = { ...process.env, CONTENT_STUDIO_ENABLED: 'false' }
    const db = adminWithRpc({ data: [], error: null })

    const result = await call(claim, 'claim', { workerId: 'w1', kinds: ['ingest_asset'], limit: 2, leaseSeconds: 60 })

    expect(result.body).toEqual({ jobs: [] })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('maps a database refusal and handles a null result', async () => {
    adminWithRpc({ data: null, error: { code: '22023', message: 'bad limit' } })
    expect((await call(claim, 'claim', { workerId: 'w', kinds: ['ingest_asset'], limit: 1 })).status).toBe(400)

    adminWithRpc({ data: null, error: null })
    expect((await call(claim, 'claim', { workerId: 'w', kinds: ['ingest_asset'], limit: 1 })).body).toEqual({ jobs: [] })
  })
})

describe('heartbeat, checkpoint, begin-dispatch, fail', () => {
  it.each([
    ['ok', 'ok'],
    ['cancel_requested', 'cancel_requested'],
    ['lost', 'lost'],
    [null, 'lost'],
  ])('heartbeat answers %s as %s', async (data, state) => {
    const db = adminWithRpc({ data, error: null })

    expect((await call(heartbeat, 'heartbeat', { ...REF, leaseSeconds: 90 })).body).toEqual({ state })
    expect(db.rpc).toHaveBeenCalledWith('heartbeat_content_job', { p_job_id: IDS.job, p_token: IDS.token, p_lease_seconds: 90 })
  })

  it('heartbeat uses the default lease', async () => {
    const db = adminWithRpc({ data: 'ok', error: null })
    await call(heartbeat, 'heartbeat', REF)
    expect(db.rpc.mock.calls[0][1]).toMatchObject({ p_lease_seconds: 120 })
  })

  it('checkpoint acknowledges only the lease holder', async () => {
    const db = adminWithRpc({ data: true, error: null })
    expect((await call(checkpoint, 'checkpoint', { ...REF, checkpoint: { containerId: 'c' } })).body).toEqual({ accepted: true })
    expect(db.rpc).toHaveBeenCalledWith('checkpoint_content_job', { p_job_id: IDS.job, p_token: IDS.token, p_checkpoint: { containerId: 'c' } })

    adminWithRpc({ data: false, error: null })
    expect((await call(checkpoint, 'checkpoint', { ...REF, checkpoint: {} })).body).toEqual({ accepted: false })
  })

  it('checkpoint refuses a credential', async () => {
    expect((await call(checkpoint, 'checkpoint', { ...REF, checkpoint: { accessToken: 'x' } })).status).toBe(400)
  })

  it.each([
    ['go', 'go'],
    ['refused', 'refused'],
    ['lost', 'lost'],
  ])('begin-dispatch answers %s', async (data, decision) => {
    adminWithRpc({ data, error: null })
    expect((await call(beginDispatch, 'begin-dispatch', REF)).body).toEqual({ decision })
  })

  it('fail forwards the outcome and request id', async () => {
    const db = adminWithRpc({ data: true, error: null })

    const result = await call(fail, 'fail', { ...REF, outcome: 'uncertain', errorCode: 'timeout', message: 'slow', providerRequestId: 'r1' })

    expect(result.body).toEqual({ accepted: true })
    expect(db.rpc).toHaveBeenCalledWith('fail_content_job', {
      p_job_id: IDS.job,
      p_token: IDS.token,
      p_outcome: 'uncertain',
      p_error_code: 'timeout',
      p_message: 'slow',
      p_provider_request_id: 'r1',
    })

    adminWithRpc({ data: false, error: null })
    const stale = await call(fail, 'fail', { ...REF, outcome: 'retry', errorCode: 'x', message: '' })
    expect(stale.body).toEqual({ accepted: false })
  })
})

describe('context', () => {
  it('returns the context of the lease holder', async () => {
    adminWithRpc({ data: null, error: null })
    mockBuildJobContext.mockResolvedValue({ kind: 'generate_text', input: {} })

    expect((await call(context, 'context', REF)).body).toEqual({ context: { kind: 'generate_text', input: {} } })
    expect(mockBuildJobContext).toHaveBeenCalledWith(expect.anything(), IDS.job, IDS.token)
  })

  it('answers 409 lease_lost for a stale worker', async () => {
    adminWithRpc({ data: null, error: null })
    mockBuildJobContext.mockResolvedValue(null)

    expect(await call(context, 'context', REF)).toEqual({
      status: 409,
      body: { error: 'The lease on this job is no longer held.', code: 'lease_lost' },
    })
  })

  it('hides unexpected failures', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    adminWithRpc({ data: null, error: null })
    mockBuildJobContext.mockRejectedValue(new Error('internal detail'))

    try {
      expect(await call(context, 'context', REF)).toEqual({ status: 500, body: { error: 'The worker request failed.' } })
    } finally {
      spy.mockRestore()
    }
  })
})

describe('complete', () => {
  const RESULT = { externalId: '123', permalink: 'https://x.example/p' }

  it('applies a valid result for the lease holder', async () => {
    const db = adminWithRpc({ data: true, error: null })
    mockFindLeasedJob.mockResolvedValue(jobRow({ kind: 'publish_social' }))

    expect((await call(complete, 'complete', { ...REF, result: RESULT })).body).toEqual({ accepted: true })
    expect(db.rpc).toHaveBeenCalledWith('complete_content_job', { p_job_id: IDS.job, p_token: IDS.token, p_result: RESULT })
  })

  it('discards a stale worker result without calling the database function', async () => {
    const db = adminWithRpc({ data: true, error: null })
    mockFindLeasedJob.mockResolvedValue(null)

    expect((await call(complete, 'complete', { ...REF, result: RESULT })).body).toEqual({ accepted: false })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('refuses a result of the wrong shape for the job kind', async () => {
    const db = adminWithRpc({ data: true, error: null })
    mockFindLeasedJob.mockResolvedValue(jobRow({ kind: 'ingest_asset' }))

    const result = await call(complete, 'complete', { ...REF, result: RESULT })

    expect(result.status).toBe(400)
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('maps a database refusal', async () => {
    adminWithRpc({ data: null, error: { code: 'CRM06', message: 'publish_social must call begin-dispatch before completing.' } })
    mockFindLeasedJob.mockResolvedValue(jobRow({ kind: 'publish_social' }))

    expect((await call(complete, 'complete', { ...REF, result: RESULT })).status).toBe(409)
  })
})

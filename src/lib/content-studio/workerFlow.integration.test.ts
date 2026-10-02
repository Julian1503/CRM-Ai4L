/**
 * @jest-environment node
 *
 * The Content Studio job protocol against the real database: leases, stale workers,
 * recovery before and after begin-dispatch, late regeneration results, idempotent
 * enqueue and review of a superseded revision. Unit tests can only check the calls that
 * would be made; these check what the SQL functions actually decide.
 *
 * Fixtures carry a unique title and are never physically deleted. Jobs this suite leaves
 * uncertain are resolved at the end so they do not linger in Operations.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

import type { ContentItemRow, Database } from '@/lib/db/types'
import { describeIntegration, must, serviceClient, uniqueTag } from '@/test/integration'

import { reviewRevision } from './approvals'
import { enqueueGeneration, ingestKey } from './jobs'
import { saveRevision } from './revisions'
import { beginDispatch, claimJobs, complete, failJob, heartbeat } from './workerOps'

jest.setTimeout(60_000)

type Db = SupabaseClient<Database>

const ORIGINAL_ENV = process.env
const PAST = '2000-01-01T00:00:00Z'
const RANDOM_TOKEN = '99999999-9999-4999-8999-999999999999'

beforeAll(() => {
  process.env = { ...ORIGINAL_ENV, CONTENT_STUDIO_ENABLED: 'true' }
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

async function newItem(db: Db): Promise<ContentItemRow> {
  const brand = await must(db.from('content_brand_profiles').select('id').eq('slug', 'ai4l').single())
  return must(
    db
      .from('content_items')
      .insert({ brand_id: brand.id, title: uniqueTag('it-content'), brief: { topic: 'Integration' }, channels: ['linkedin', 'email'] })
      .select('*')
      .single()
  )
}

/** A variant with one revision, made through the member function (the service role may call it). */
async function newVariant(db: Db, item: ContentItemRow) {
  const variant = await must(db.from('content_variants').insert({ item_id: item.id, channel: 'linkedin' }).select('*').single())
  const revision = await saveRevision(db, variant.id, {
    idempotencyKey: uniqueTag('rev'),
    expectedRevisionId: null,
    content: { body: 'First', hashtags: [], callToAction: null, linkUrl: null, fields: {}, assets: [] },
  })
  return { variantId: variant.id, revisionId: revision.id }
}

async function newIngestJob(db: Db): Promise<string> {
  const asset = await must(
    db
      .from('content_assets')
      .insert({
        brand_id: (await must(db.from('content_brand_profiles').select('id').eq('slug', 'ai4l').single())).id,
        origin: 'upload',
        ingest_status: 'pending',
        quarantine_path: `uploads/${uniqueTag('it')}/photo.png`,
        mime_type: 'image/png',
        byte_size: 10,
      })
      .select('id')
      .single()
  )
  const job = await must(db.rpc('enqueue_content_job', { p_kind: 'ingest_asset', p_idempotency_key: ingestKey(asset.id), p_asset_id: asset.id, p_input: {} }))
  return (job as unknown as { id: string }).id
}

/** Puts a queued job first in line, so a claim of its kind picks it rather than other local work. */
async function prioritise(db: Db, jobId: string): Promise<void> {
  const { error } = await db.from('content_jobs').update({ next_attempt_at: PAST }).eq('id', jobId)
  if (error) throw new Error(error.message)
}

async function claimOwn(db: Db, jobId: string, kind: 'ingest_asset' | 'generate_text', workerId: string): Promise<string> {
  await prioritise(db, jobId)
  const { jobs } = await claimJobs(db, { workerId, kinds: [kind], limit: 1, leaseSeconds: 60 })
  const own = jobs.find((job) => job.jobId === jobId)
  if (!own) throw new Error('The job was not claimed first; another worker may be draining the local queue.')
  return own.claimToken
}

async function expireLease(db: Db, jobId: string): Promise<void> {
  const { error } = await db.from('content_jobs').update({ lease_expires_at: PAST }).eq('id', jobId)
  if (error) throw new Error(error.message)
  await must(db.rpc('recover_content_jobs'))
}

async function jobStatus(db: Db, jobId: string): Promise<string> {
  return (await must(db.from('content_jobs').select('status').eq('id', jobId).single())).status
}

const uncertainJobs: string[] = []

describeIntegration('content job protocol against Postgres', () => {
  afterAll(async () => {
    const db = serviceClient()
    for (const id of uncertainJobs) {
      await db.rpc('resolve_uncertain_content_job', { p_job_id: id, p_resolution: 'failed', p_note: 'Integration test fixture.' })
    }
  })

  it('gives one lease to one worker; a stranger cannot heartbeat, fail or complete it', async () => {
    const db = serviceClient()
    const jobId = await newIngestJob(db)
    const token = await claimOwn(db, jobId, 'ingest_asset', 'worker-a')

    const second = await claimJobs(db, { workerId: 'worker-b', kinds: ['ingest_asset'], limit: 20, leaseSeconds: 60 })
    expect(second.jobs.map((job) => job.jobId)).not.toContain(jobId)
    // Release anything worker-b picked up from other local work.
    for (const job of second.jobs) await failJob(db, { jobId: job.jobId, claimToken: job.claimToken, outcome: 'retry', errorCode: 'it', message: '' })

    expect(await heartbeat(db, { jobId, claimToken: RANDOM_TOKEN })).toEqual({ state: 'lost' })
    expect(await failJob(db, { jobId, claimToken: RANDOM_TOKEN, outcome: 'failed', errorCode: 'x', message: '' })).toEqual({ accepted: false })
    expect(await complete(db, { jobId, claimToken: RANDOM_TOKEN, result: { status: 'rejected', reason: 'x' } })).toEqual({ accepted: false })

    expect(await heartbeat(db, { jobId, claimToken: token })).toEqual({ state: 'ok' })
    expect(await complete(db, { jobId, claimToken: token, result: { status: 'rejected', reason: 'Not an image.' } })).toEqual({ accepted: true })
    expect(await jobStatus(db, jobId)).toBe('succeeded')
  })

  it('requeues a lease that expired before begin-dispatch, and the stale worker can no longer complete', async () => {
    const db = serviceClient()
    const jobId = await newIngestJob(db)
    const staleToken = await claimOwn(db, jobId, 'ingest_asset', 'worker-a')

    await expireLease(db, jobId)
    expect(await jobStatus(db, jobId)).toBe('queued')

    const freshToken = await claimOwn(db, jobId, 'ingest_asset', 'worker-b')
    expect(await complete(db, { jobId, claimToken: staleToken, result: { status: 'rejected', reason: 'late' } })).toEqual({ accepted: false })
    expect(await complete(db, { jobId, claimToken: freshToken, result: { status: 'rejected', reason: 'Not an image.' } })).toEqual({ accepted: true })
  })

  it('makes a lease that expired after begin-dispatch uncertain, never retried', async () => {
    const db = serviceClient()
    const item = await newItem(db)
    const job = await enqueueGeneration(db, item, { idempotencyKey: uniqueTag('gen'), channels: ['linkedin'] })
    const token = await claimOwn(db, job.id, 'generate_text', 'worker-a')

    expect(await beginDispatch(db, { jobId: job.id, claimToken: token })).toEqual({ decision: 'go' })
    await expireLease(db, job.id)

    expect(await jobStatus(db, job.id)).toBe('uncertain')
    uncertainJobs.push(job.id)
  })

  it('turns a regeneration result for a superseded revision into a new variant', async () => {
    const db = serviceClient()
    const item = await newItem(db)
    const { variantId, revisionId } = await newVariant(db, item)
    const job = await enqueueGeneration(db, item, {
      idempotencyKey: uniqueTag('regen'),
      channels: ['linkedin'],
      variantId,
      baseRevisionId: revisionId,
    })

    // The operator edits while the regeneration is queued.
    const edited = await saveRevision(db, variantId, {
      idempotencyKey: uniqueTag('edit'),
      expectedRevisionId: revisionId,
      content: { body: 'Edited by a person', hashtags: [], callToAction: null, linkUrl: null, fields: {}, assets: [] },
    })

    const token = await claimOwn(db, job.id, 'generate_text', 'worker-a')
    await beginDispatch(db, { jobId: job.id, claimToken: token })
    const result = {
      variants: [{ channel: 'linkedin', style: 'default', body: 'Regenerated', hashtags: [], callToAction: null, violations: [] }],
      failures: [],
      promptVersion: 'it-1',
      model: 'mock',
    }
    expect(await complete(db, { jobId: job.id, claimToken: token, result: result as never })).toEqual({ accepted: true })

    const original = await must(db.from('content_variants').select('current_revision_id').eq('id', variantId).single())
    expect(original.current_revision_id).toBe(edited.id)

    const conflicts = await must(db.from('content_variants').select('id, conflict_of_revision_id').eq('item_id', item.id).neq('id', variantId))
    expect(conflicts).toEqual([expect.objectContaining({ conflict_of_revision_id: revisionId })])
  })

  it('enqueues idempotently: the same key returns the same job', async () => {
    const db = serviceClient()
    const item = await newItem(db)
    const key = uniqueTag('idem')

    const first = await enqueueGeneration(db, item, { idempotencyKey: key, channels: ['email'] })
    const second = await enqueueGeneration(db, item, { idempotencyKey: key, channels: ['email'] })

    expect(second.id).toBe(first.id)
    await db.rpc('cancel_content_job', { p_job_id: first.id })
  })

  it('refuses to review a revision that is no longer current', async () => {
    const db = serviceClient()
    const item = await newItem(db)
    const { variantId, revisionId } = await newVariant(db, item)
    await saveRevision(db, variantId, {
      idempotencyKey: uniqueTag('edit'),
      expectedRevisionId: revisionId,
      content: { body: 'Second', hashtags: [], callToAction: null, linkUrl: null, fields: {}, assets: [] },
    })

    await expect(reviewRevision(db, variantId, { revisionId, decision: 'approved' })).rejects.toMatchObject({
      sqlState: 'CRM06',
      hint: 'stale_revision',
    })
  })

  it('never gives the same job to two workers claiming at the same time', async () => {
    const db = serviceClient()
    const own = await Promise.all(Array.from({ length: 10 }, () => newIngestJob(db)))
    await Promise.all(own.map((id) => prioritise(db, id)))

    const [a, b] = await Promise.all([
      claimJobs(db, { workerId: 'race-a', kinds: ['ingest_asset'], limit: 20, leaseSeconds: 60 }),
      claimJobs(db, { workerId: 'race-b', kinds: ['ingest_asset'], limit: 20, leaseSeconds: 60 }),
    ])
    const idsA = a.jobs.map((job) => job.jobId)
    const idsB = b.jobs.map((job) => job.jobId)

    expect(idsA.filter((id) => idsB.includes(id))).toEqual([])
    expect([...idsA, ...idsB].filter((id) => own.includes(id)).sort()).toEqual([...own].sort())

    // Settle everything claimed: own fixtures as failed, anything else back to the queue.
    for (const job of [...a.jobs, ...b.jobs]) {
      const outcome = own.includes(job.jobId) ? 'failed' : 'retry'
      await failJob(db, { jobId: job.jobId, claimToken: job.claimToken, outcome, errorCode: 'integration_test', message: '' })
    }
  })

  it('refuses a stale edit with stale_revision', async () => {
    const db = serviceClient()
    const item = await newItem(db)
    const { variantId } = await newVariant(db, item)

    await expect(
      saveRevision(db, variantId, {
        idempotencyKey: uniqueTag('stale'),
        expectedRevisionId: null,
        content: { body: 'Stale', hashtags: [], callToAction: null, linkUrl: null, fields: {}, assets: [] },
      })
    ).rejects.toMatchObject({ sqlState: 'CRM06', hint: 'stale_revision' })
  })
})

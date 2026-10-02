/** @jest-environment node */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { reviewRevision } from './approvals'
import { cancelJob, enqueueGeneration, enqueueImageGeneration, enqueueIngest, getJob, ingestKey, resolveJob } from './jobs'
import { duplicateVariant, saveRevision, updateVariant } from './revisions'
import { assetRow, IDS, itemRow, jobRow, reviewRow, revisionRow, variantRow } from './testFixtures'

function dbWith(tables: Record<string, unknown>, rpc: unknown = { data: null, error: null }) {
  const db = createDbMock((table: string) => createQueryBuilderMock(tables[table] ?? { data: [], error: null }))
  db.rpc.mockResolvedValue(rpc)
  return db
}

const KEY = 'key-12345678'
const CONTENT = { body: 'b', hashtags: [], callToAction: null, linkUrl: null, fields: {}, assets: [] }

describe('saveRevision', () => {
  it('calls create_content_revision and returns the revision with its review state', async () => {
    const db = dbWith({ content_reviews: { data: [reviewRow()], error: null } }, { data: revisionRow(), error: null })

    const revision = await saveRevision(db as never, IDS.variant, { idempotencyKey: KEY, expectedRevisionId: null, content: CONTENT })

    expect(db.rpc).toHaveBeenCalledWith('create_content_revision', {
      p_variant_id: IDS.variant,
      p_expected_revision_id: null,
      p_content: CONTENT,
      p_idempotency_key: KEY,
    })
    expect(revision).toMatchObject({ id: IDS.revision, review: 'approved' })
  })

  it('propagates a stale-edit refusal with its hint', async () => {
    const db = dbWith({}, { data: null, error: { code: 'CRM06', hint: 'stale_revision', message: 'changed' } })

    await expect(
      saveRevision(db as never, IDS.variant, { idempotencyKey: KEY, expectedRevisionId: IDS.revision, content: CONTENT })
    ).rejects.toMatchObject({ sqlState: 'CRM06', hint: 'stale_revision' })
  })

  it('surfaces a review read error', async () => {
    const db = dbWith({ content_reviews: { data: null, error: { message: 'r' } } }, { data: revisionRow(), error: null })

    await expect(saveRevision(db as never, IDS.variant, { idempotencyKey: KEY, expectedRevisionId: null, content: CONTENT })).rejects.toThrow('r')
  })
})

describe('duplicateVariant', () => {
  it('returns the new variant with its current revision', async () => {
    const db = dbWith(
      { content_variant_revisions: { data: [revisionRow()], error: null }, content_reviews: { data: [], error: null } },
      { data: variantRow(), error: null }
    )

    const variant = await duplicateVariant(db as never, IDS.variant, { idempotencyKey: KEY })

    expect(db.rpc).toHaveBeenCalledWith('duplicate_content_variant', { p_variant_id: IDS.variant, p_idempotency_key: KEY })
    expect(variant.current).toMatchObject({ id: IDS.revision, review: 'pending' })
  })

  it('propagates a not-found error', async () => {
    const db = dbWith({}, { data: null, error: { code: 'P0002', message: 'Variant not found.' } })
    await expect(duplicateVariant(db as never, IDS.variant, { idempotencyKey: KEY })).rejects.toMatchObject({ sqlState: 'P0002' })
  })
})

describe('reviewRevision', () => {
  it('reviews a revision of this variant', async () => {
    const db = dbWith(
      { content_variant_revisions: { data: { id: IDS.revision, variant_id: IDS.variant }, error: null } },
      { data: reviewRow({ decision: 'rejected', reason: 'tone' }), error: null }
    )

    const review = await reviewRevision(db as never, IDS.variant, { revisionId: IDS.revision, decision: 'rejected', reason: 'tone' })

    expect(db.rpc).toHaveBeenCalledWith('review_content_revision', { p_revision_id: IDS.revision, p_decision: 'rejected', p_reason: 'tone' })
    expect(review).toMatchObject({ revisionId: IDS.revision, decision: 'rejected', reason: 'tone' })
  })

  it('refuses a revision of another variant before calling the database function', async () => {
    const db = dbWith({ content_variant_revisions: { data: { id: IDS.revision, variant_id: 'other' }, error: null } })

    await expect(reviewRevision(db as never, IDS.variant, { revisionId: IDS.revision, decision: 'approved' })).rejects.toMatchObject({
      status: 404,
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('refuses a missing revision and passes a null reason', async () => {
    const missing = dbWith({ content_variant_revisions: { data: null, error: null } })
    await expect(reviewRevision(missing as never, IDS.variant, { revisionId: IDS.revision, decision: 'approved' })).rejects.toMatchObject({
      status: 404,
    })

    const db = dbWith({ content_variant_revisions: { data: { id: IDS.revision, variant_id: IDS.variant }, error: null } }, { data: reviewRow(), error: null })
    await reviewRevision(db as never, IDS.variant, { revisionId: IDS.revision, decision: 'approved' })
    expect(db.rpc.mock.calls[0][1]).toMatchObject({ p_reason: null })
  })
})

describe('enqueueGeneration', () => {
  it('snapshots the brief into the job input', async () => {
    const db = dbWith({}, { data: jobRow({ status: 'queued' }), error: null })

    const job = await enqueueGeneration(db as never, itemRow(), { idempotencyKey: KEY, channels: ['linkedin'], stylesPerChannel: 2 })

    expect(job.status).toBe('queued')
    expect(db.rpc).toHaveBeenCalledWith('enqueue_content_job', {
      p_kind: 'generate_text',
      p_idempotency_key: KEY,
      p_item_id: IDS.item,
      p_variant_id: null,
      p_base_revision_id: null,
      p_input: { itemId: IDS.item, channels: ['linkedin'], stylesPerChannel: 2, brief: { topic: 'AI adoption' } },
    })
  })

  it('checks a regeneration target and carries the base revision and instruction', async () => {
    const db = dbWith(
      { content_variants: { data: { id: IDS.variant, item_id: IDS.item, channel: 'linkedin', archived_at: null }, error: null } },
      { data: jobRow(), error: null }
    )

    await enqueueGeneration(db as never, itemRow(), {
      idempotencyKey: KEY,
      channels: ['linkedin'],
      variantId: IDS.variant,
      baseRevisionId: IDS.revision,
      instruction: 'shorter',
    })

    expect(db.rpc.mock.calls[0][1]).toMatchObject({
      p_variant_id: IDS.variant,
      p_base_revision_id: IDS.revision,
      p_input: { variantId: IDS.variant, baseRevisionId: IDS.revision, instruction: 'shorter', stylesPerChannel: 1 },
    })
  })

  it.each([
    ['another item', { id: IDS.variant, item_id: 'other', channel: 'linkedin', archived_at: null }, 404],
    ['missing', null, 404],
    ['another channel', { id: IDS.variant, item_id: IDS.item, channel: 'email', archived_at: null }, 422],
  ])('refuses a regeneration target in %s', async (_name, variant, status) => {
    const db = dbWith({ content_variants: { data: variant, error: null } })

    await expect(
      enqueueGeneration(db as never, itemRow(), { idempotencyKey: KEY, channels: ['linkedin'], variantId: IDS.variant, baseRevisionId: IDS.revision })
    ).rejects.toMatchObject({ status })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('refuses archived items and channels the item does not plan', async () => {
    const db = dbWith({})

    await expect(enqueueGeneration(db as never, itemRow({ archived_at: 'x' }), { idempotencyKey: KEY, channels: ['linkedin'] })).rejects.toMatchObject({
      status: 409,
    })
    await expect(enqueueGeneration(db as never, itemRow(), { idempotencyKey: KEY, channels: ['instagram'] })).rejects.toMatchObject({
      status: 422,
      code: 'channel_mismatch',
    })
  })
})

describe('other jobs', () => {
  it('enqueueImageGeneration defaults quality', async () => {
    const db = dbWith({}, { data: jobRow({ kind: 'generate_image' }), error: null })

    await enqueueImageGeneration(db as never, itemRow(), { idempotencyKey: KEY, prompt: 'p', count: 2 })

    expect(db.rpc.mock.calls[0][1]).toMatchObject({ p_kind: 'generate_image', p_input: { itemId: IDS.item, prompt: 'p', count: 2, quality: 'medium' } })
    await expect(enqueueImageGeneration(db as never, itemRow({ archived_at: 'x' }), { idempotencyKey: KEY, prompt: 'p', count: 1, quality: 'low' })).rejects.toMatchObject({ status: 409 })
  })

  it('enqueueIngest uses one key per asset and only for pending uploads', async () => {
    const db = dbWith({}, { data: jobRow({ kind: 'ingest_asset' }), error: null })
    const pending = assetRow({ ingest_status: 'pending' })

    await enqueueIngest(db as never, pending)

    expect(db.rpc).toHaveBeenCalledWith('enqueue_content_job', {
      p_kind: 'ingest_asset',
      p_idempotency_key: ingestKey(IDS.asset),
      p_asset_id: IDS.asset,
      p_input: { assetId: IDS.asset, quarantinePath: pending.quarantine_path },
    })
    await expect(enqueueIngest(db as never, assetRow({ origin: 'generated' }))).rejects.toMatchObject({ status: 409 })
    await expect(enqueueIngest(db as never, assetRow({ ingest_status: 'pending', archived_at: 'x' }))).rejects.toMatchObject({ status: 409 })
    await expect(enqueueIngest(db as never, assetRow())).rejects.toMatchObject({ status: 409, code: 'asset_not_pending' })
  })

  it('getJob, cancelJob and resolveJob map rows and errors', async () => {
    const found = dbWith({ content_jobs: { data: jobRow(), error: null } })
    await expect(getJob(found as never, IDS.job)).resolves.toMatchObject({ id: IDS.job })
    const selected = String((found.from.mock.results[0].value as ReturnType<typeof createQueryBuilderMock>).argsFor('select')?.[0])
    expect(selected).not.toContain('claim_token')
    expect(selected).not.toContain('*')
    const missing = dbWith({ content_jobs: { data: null, error: null } })
    await expect(getJob(missing as never, IDS.job)).resolves.toBeNull()

    const cancel = dbWith({}, { data: jobRow({ status: 'cancelled' }), error: null })
    await expect(cancelJob(cancel as never, IDS.job)).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancel.rpc).toHaveBeenCalledWith('cancel_content_job', { p_job_id: IDS.job })

    const resolve = dbWith({ content_jobs: { data: jobRow({ kind: 'publish_social', status: 'uncertain' }), error: null } }, { data: jobRow({ status: 'succeeded' }), error: null })
    await resolveJob(resolve as never, IDS.job, { resolution: 'succeeded', note: 'seen', permalink: 'https://x.example' })
    expect(resolve.from).toHaveBeenCalledWith('content_jobs')
    expect(resolve.rpc).toHaveBeenCalledWith('resolve_uncertain_content_job', {
      p_job_id: IDS.job,
      p_resolution: 'succeeded',
      p_note: 'seen',
      p_external_id: null,
      p_permalink: 'https://x.example',
    })

    const generation = dbWith({ content_jobs: { data: jobRow({ status: 'uncertain' }), error: null } })
    await expect(resolveJob(generation as never, IDS.job, { resolution: 'succeeded', note: 'n' })).rejects.toMatchObject({ status: 400 })
    expect(generation.rpc).not.toHaveBeenCalled()
    const gone = dbWith({ content_jobs: { data: null, error: null } })
    await expect(resolveJob(gone as never, IDS.job, { resolution: 'succeeded', note: 'n' })).rejects.toMatchObject({ status: 404 })

    const refused = dbWith({}, { data: null, error: { code: 'CRM06', message: 'Only an uncertain job can be resolved.' } })
    await expect(resolveJob(refused as never, IDS.job, { resolution: 'failed', note: 'n', externalId: 'e' })).rejects.toMatchObject({ sqlState: 'CRM06' })
  })
})

describe('updateVariant', () => {
  function variantDb(responses: unknown[]) {
    const builders: Record<string, unknown> = {
      content_variants: createQueryBuilderMock(responses),
      content_variant_revisions: createQueryBuilderMock({ data: [revisionRow()], error: null }),
      content_reviews: createQueryBuilderMock({ data: [], error: null }),
      content_audit_events: createQueryBuilderMock({ data: null, error: null }),
    }
    return { db: createDbMock((table: string) => builders[table]), builders }
  }

  it('archives an active variant and audits it', async () => {
    const { db, builders } = variantDb([{ data: variantRow(), error: null }, { data: variantRow({ archived_at: 'now' }), error: null }])

    const variant = await updateVariant(db as never, IDS.variant, IDS.user, { archived: true })

    expect(variant?.archivedAt).toBe('now')
    const update = (builders.content_variants as ReturnType<typeof createQueryBuilderMock>).argsFor('update') as [{ archived_at: string }]
    expect(typeof update[0].archived_at).toBe('string')
    expect(db.rpc).toHaveBeenCalledWith('record_content_audit', expect.objectContaining({
      p_action: 'variant.archived',
      p_subject_type: 'content_variant',
    }))
  })

  it('restores an archived variant', async () => {
    const { db, builders } = variantDb([{ data: variantRow({ archived_at: 'then' }), error: null }, { data: variantRow(), error: null }])

    await updateVariant(db as never, IDS.variant, IDS.user, { archived: false })

    expect((builders.content_variants as ReturnType<typeof createQueryBuilderMock>).argsFor('update')).toEqual([{ archived_at: null }])
  })

  it('changes nothing when the state already matches, and returns null for a missing variant', async () => {
    const same = variantDb([{ data: variantRow(), error: null }])
    await expect(updateVariant(same.db as never, IDS.variant, IDS.user, { archived: false })).resolves.toMatchObject({ id: IDS.variant })
    expect((same.builders.content_variants as ReturnType<typeof createQueryBuilderMock>).argsFor('update')).toBeUndefined()

    const missing = variantDb([{ data: null, error: null }])
    await expect(updateVariant(missing.db as never, IDS.variant, IDS.user, { archived: true })).resolves.toBeNull()
  })
})

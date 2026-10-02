/** @jest-environment node */
import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

import {
  createItem,
  findItemRow,
  getBrand,
  getDefaultBrand,
  getItem,
  hydrateVariants,
  listItems,
  updateItem,
} from './repository'
import { brandRow, IDS, itemRow, jobRow, publicationRow, reviewRow, revisionRow, variantRow } from './testFixtures'

type Tables = Record<string, unknown>

function dbWith(tables: Tables) {
  const builders = new Map<string, QueryBuilderMock>()
  const db = createDbMock((table: string) => {
    if (!builders.has(table)) builders.set(table, createQueryBuilderMock(tables[table] ?? { data: [], error: null }))
    return builders.get(table)
  })
  return { db, builder: (table: string) => builders.get(table) as QueryBuilderMock }
}

const OK_AUDIT = { data: null, error: null }

/** The audit action recorded through record_content_audit, if any. */
function auditAction(db: { rpc: jest.Mock }): unknown {
  return db.rpc.mock.calls.find((call) => call[0] === 'record_content_audit')?.[1]?.p_action
}


describe('brand profile', () => {
  it('reads the AI4L profile', async () => {
    const { db, builder } = dbWith({ content_brand_profiles: { data: brandRow(), error: null } })

    await expect(getDefaultBrand(db as never)).resolves.toMatchObject({ slug: 'ai4l' })
    expect(builder('content_brand_profiles').argsFor('eq')).toEqual(['slug', 'ai4l'])
  })

  it('fails loudly when a profile is missing', async () => {
    const { db } = dbWith({ content_brand_profiles: { data: null, error: null } })

    await expect(getDefaultBrand(db as never)).rejects.toThrow(/missing/)
    await expect(getBrand(db as never, IDS.brand)).rejects.toThrow(/missing/)
  })

  it('reads a brand by id', async () => {
    const { db } = dbWith({ content_brand_profiles: { data: brandRow(), error: null } })
    await expect(getBrand(db as never, IDS.brand)).resolves.toMatchObject({ id: IDS.brand })
  })
})

describe('listItems', () => {
  it('pages active items with their counts', async () => {
    const other = '00000000-0000-4000-8000-00000000c002'
    const { db, builder } = dbWith({
      content_items: { data: [itemRow(), itemRow({ id: other })], error: null, count: 12 },
      content_variants: {
        data: [
          { item_id: IDS.item, current_revision_id: IDS.revision },
          { item_id: IDS.item, current_revision_id: IDS.revision2 },
          { item_id: IDS.item, current_revision_id: null },
        ],
        error: null,
      },
      content_jobs: { data: [{ item_id: IDS.item }], error: null },
      content_reviews: { data: [reviewRow()], error: null },
    })

    const result = await listItems(db as never, { page: 2, pageSize: 2, search: null, status: 'active' })

    expect(result.total).toBe(12)
    expect(result.items[0]).toMatchObject({ variantCount: 3, approvedCount: 1, pendingReviewCount: 1, activeJobCount: 1 })
    expect(result.items[1]).toMatchObject({ variantCount: 0, activeJobCount: 0 })
    expect(builder('content_items').argsFor('range')).toEqual([2, 3])
    expect(builder('content_items').allFor('is').map((call) => call.args)).toContainEqual(['archived_at', null])
  })

  it('searches archived items with LIKE metacharacters escaped', async () => {
    const { db, builder } = dbWith({ content_items: { data: [], error: null, count: 0 } })

    const result = await listItems(db as never, { page: 1, pageSize: 50, search: '50%_off', status: 'archived' })

    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 50 })
    expect(builder('content_items').argsFor('ilike')).toEqual(['title', '%50\\%\\_off%'])
    expect(builder('content_items').argsFor('not')).toEqual(['archived_at', 'is', null])
    expect(db.from).not.toHaveBeenCalledWith('content_variants')
  })

  it('surfaces a query failure as a database error', async () => {
    const { db } = dbWith({ content_items: { data: null, error: { code: '42501', message: 'no' } } })

    await expect(listItems(db as never, { page: 1, pageSize: 5, search: null, status: 'active' })).rejects.toMatchObject({
      sqlState: '42501',
    })
  })

  it('treats a missing count as zero and skips reviews without revisions', async () => {
    const { db } = dbWith({
      content_items: { data: [itemRow()], error: null, count: null },
      content_variants: { data: [{ item_id: IDS.item, current_revision_id: null }], error: null },
      content_jobs: { data: null, error: null },
    })

    const result = await listItems(db as never, { page: 1, pageSize: 5, search: null, status: 'active' })

    expect(result.total).toBe(0)
    expect(result.items[0]).toMatchObject({ variantCount: 1, pendingReviewCount: 0 })
    expect(db.from).not.toHaveBeenCalledWith('content_reviews')
  })
})

describe('getItem', () => {
  it('returns null for a missing or removed item', async () => {
    const { db, builder } = dbWith({ content_items: { data: null, error: null } })

    await expect(getItem(db as never, IDS.item)).resolves.toBeNull()
    expect(builder('content_items').allFor('is').map((call) => call.args)).toContainEqual(['removed_at', null])
  })

  it('assembles variants, current revisions with review state, jobs and publications', async () => {
    const { db } = dbWith({
      content_items: { data: itemRow(), error: null },
      content_variants: { data: [variantRow(), variantRow({ id: 'v2', current_revision_id: null })], error: null },
      content_jobs: { data: [jobRow({ status: 'succeeded' })], error: null },
      content_variant_revisions: { data: [revisionRow()], error: null },
      content_reviews: { data: [reviewRow({ decision: 'rejected', reason: 'tone' })], error: null },
      social_publications: { data: [publicationRow()], error: null },
    })

    const item = await getItem(db as never, IDS.item)

    expect(item?.variants[0].current).toMatchObject({ id: IDS.revision, review: 'rejected', reviewReason: 'tone' })
    expect(item?.variants[1].current).toBeNull()
    expect(item?.jobs[0]).toMatchObject({ status: 'succeeded' })
    expect(item?.publications[0]).toMatchObject({ id: IDS.publication })
  })

  it('skips nested reads for an item without variants', async () => {
    const { db } = dbWith({
      content_items: { data: itemRow(), error: null },
      content_variants: { data: null, error: null },
      content_jobs: { data: null, error: null },
    })

    await expect(getItem(db as never, IDS.item)).resolves.toMatchObject({ variants: [], jobs: [], publications: [] })
    expect(db.from).not.toHaveBeenCalledWith('social_publications')
  })

  it('surfaces errors from nested reads', async () => {
    const { db } = dbWith({
      content_items: { data: itemRow(), error: null },
      content_variants: { data: [variantRow()], error: null },
      content_jobs: { data: [], error: null },
      content_variant_revisions: { data: null, error: { message: 'x', code: 'XX000' } },
    })

    await expect(getItem(db as never, IDS.item)).rejects.toThrow('x')
  })

  it('surfaces a publication read error', async () => {
    const { db } = dbWith({
      content_items: { data: itemRow(), error: null },
      content_variants: { data: [variantRow({ current_revision_id: null })], error: null },
      content_jobs: { data: [], error: null },
      social_publications: { data: null, error: { message: 'pubs' } },
    })

    await expect(getItem(db as never, IDS.item)).rejects.toThrow('pubs')
  })
})

describe('hydrateVariants', () => {
  it('leaves a variant whose revision is unreadable without a current revision', async () => {
    const { db } = dbWith({ content_variant_revisions: { data: null, error: null }, content_reviews: { data: null, error: null } })

    const [variant] = await hydrateVariants(db as never, [variantRow()])

    expect(variant.current).toBeNull()
  })
})

describe('createItem / updateItem', () => {
  it('creates an item for the AI4L brand, as the actor, and audits it', async () => {
    const { db, builder } = dbWith({
      content_brand_profiles: { data: brandRow(), error: null },
      content_items: { data: itemRow(), error: null },
      content_audit_events: OK_AUDIT,
    })

    const item = await createItem(db as never, IDS.user, { title: 'Launch', brief: { topic: 'AI' }, channels: ['linkedin'] })

    expect(item).toMatchObject({ id: IDS.item, variants: [] })
    expect(builder('content_items').argsFor('insert')).toEqual([
      { brand_id: IDS.brand, title: 'Launch', brief: { topic: 'AI' }, channels: ['linkedin'], created_by: IDS.user },
    ])
    expect(auditAction(db)).toBe('item.created')
  })

  it('returns null when updating a missing item', async () => {
    const { db } = dbWith({ content_items: { data: null, error: null } })

    await expect(updateItem(db as never, IDS.item, IDS.user, { title: 'x' })).resolves.toBeNull()
  })

  it('archives an active item once and audits the archive', async () => {
    const { db, builder } = dbWith({
      content_items: [
        { data: itemRow(), error: null },
        { data: null, error: null },
        { data: itemRow({ archived_at: 'now' }), error: null },
      ],
      content_audit_events: OK_AUDIT,
    })

    await updateItem(db as never, IDS.item, IDS.user, { archived: true, title: 'T', brief: { topic: 'b' }, channels: ['email'] })

    const [patch] = builder('content_items').argsFor('update') as [Record<string, unknown>]
    expect(patch).toMatchObject({ title: 'T', brief: { topic: 'b' }, channels: ['email'] })
    expect(typeof patch.archived_at).toBe('string')
    expect(auditAction(db)).toBe('item.archived')
  })

  it('restores an archived item and does not re-stamp an already archived one', async () => {
    const restore = dbWith({
      content_items: [{ data: itemRow({ archived_at: 'then' }), error: null }, { data: null, error: null }],
      content_audit_events: OK_AUDIT,
    })
    await updateItem(restore.db as never, IDS.item, IDS.user, { archived: false })
    expect((restore.builder('content_items').argsFor('update') as [Record<string, unknown>])[0].archived_at).toBeNull()
    expect(auditAction(restore.db)).toBe('item.restored')

    const again = dbWith({
      content_items: [{ data: itemRow({ archived_at: 'then' }), error: null }, { data: null, error: null }],
      content_audit_events: OK_AUDIT,
    })
    await updateItem(again.db as never, IDS.item, IDS.user, { archived: true })
    expect(again.builder('content_items').argsFor('update')?.[0]).not.toHaveProperty('archived_at')
    expect(auditAction(again.db)).toBe('item.updated')
  })

  it('findItemRow surfaces errors', async () => {
    const { db } = dbWith({ content_items: { data: null, error: { message: 'bad' } } })
    await expect(findItemRow(db as never, IDS.item)).rejects.toThrow('bad')
  })
})

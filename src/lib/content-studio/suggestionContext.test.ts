/** @jest-environment node */
import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

import { buildSuggestionContext, clip } from './suggestionContext'
import { IDS, assetRow, itemRow, reviewRow, revisionRow, variantRow } from './testFixtures'

function dbWith(tables: Record<string, unknown>) {
  const builders = new Map<string, QueryBuilderMock>()
  const db = createDbMock((table: string) => {
    if (!builders.has(table)) builders.set(table, createQueryBuilderMock(tables[table] ?? { data: [], error: null }))
    return builders.get(table)
  })
  return { db, builder: (table: string) => builders.get(table) as QueryBuilderMock }
}

const rewrite = { kind: 'rewrite_instructions' as const, variantId: IDS.variant }

describe('rewrite_instructions', () => {
  it('sends the current text, its violations and the rejection reason', async () => {
    const { db } = dbWith({
      content_variants: { data: variantRow({ current_revision_id: IDS.revision }), error: null },
      content_items: { data: itemRow(), error: null },
      content_variant_revisions: { data: [revisionRow({ violations: ['Too short'] })], error: null },
      content_reviews: { data: [reviewRow({ decision: 'rejected', reason: 'The date is wrong' })], error: null },
    })

    const context = await buildSuggestionContext(db as never, rewrite)

    expect(context).toEqual({
      channel: 'linkedin',
      body: 'Hello world.',
      hashtags: ['AI4L'],
      callToAction: 'Book now.',
      fields: {},
      violations: ['Too short'],
      reviewReason: 'The date is wrong',
    })
  })

  it('leaves the reason out unless the revision is rejected', async () => {
    const { db } = dbWith({
      content_variants: { data: variantRow({ current_revision_id: IDS.revision }), error: null },
      content_items: { data: itemRow(), error: null },
      content_variant_revisions: { data: [revisionRow()], error: null },
      content_reviews: { data: [reviewRow({ decision: 'approved', reason: 'Fine' })], error: null },
    })

    await expect(buildSuggestionContext(db as never, rewrite)).resolves.toMatchObject({ reviewReason: null })
  })

  it('answers 404 for an archived variant or a removed item, and 409 without text', async () => {
    const archived = dbWith({ content_variants: { data: variantRow({ archived_at: '2026-10-08T00:00:00Z' }), error: null } })
    await expect(buildSuggestionContext(archived.db as never, rewrite)).rejects.toMatchObject({ status: 404 })

    const removed = dbWith({ content_variants: { data: variantRow(), error: null }, content_items: { data: null, error: null } })
    await expect(buildSuggestionContext(removed.db as never, rewrite)).rejects.toMatchObject({ status: 404 })

    const empty = dbWith({
      content_variants: { data: variantRow({ current_revision_id: null }), error: null },
      content_items: { data: itemRow(), error: null },
    })
    await expect(buildSuggestionContext(empty.db as never, rewrite)).rejects.toMatchObject({ status: 409, code: 'no_revision' })
  })

  it('clips a long draft to the engine limit instead of failing', async () => {
    const { db } = dbWith({
      content_variants: { data: variantRow({ current_revision_id: IDS.revision }), error: null },
      content_items: { data: itemRow(), error: null },
      content_variant_revisions: { data: [revisionRow({ body: 'x'.repeat(12000) })], error: null },
    })

    const context = await buildSuggestionContext(db as never, rewrite)

    expect((context.body as string).length).toBe(10000)
  })
})

describe('image_prompts', () => {
  it('sends the brief, approved copy first and the prompts already used, without duplicates', async () => {
    const second = '00000000-0000-4000-8000-00000000d002'
    const { db, builder } = dbWith({
      content_items: { data: itemRow({ title: 'Workshop', brief: { topic: 'Online workshops', referenceUrl: 'https://x.test' } }), error: null },
      content_variants: {
        data: [
          variantRow({ current_revision_id: IDS.revision }),
          variantRow({ id: second, current_revision_id: IDS.revision2 }),
        ],
        error: null,
      },
      content_jobs: { data: [], error: null },
      social_publications: { data: [], error: null },
      content_variant_revisions: {
        data: [revisionRow({ body: 'Draft copy' }), revisionRow({ id: IDS.revision2, variant_id: second, body: 'Approved copy' })],
        error: null,
      },
      content_reviews: { data: [reviewRow({ revision_id: IDS.revision2 })], error: null },
      content_assets: {
        data: [assetRow({ generation_prompt: 'A desk' }), assetRow({ id: IDS.asset2, generation_prompt: 'A desk' })],
        error: null,
      },
    })

    const context = await buildSuggestionContext(db as never, { kind: 'image_prompts', itemId: IDS.item })

    expect(context).toEqual({
      title: 'Workshop',
      brief: { topic: 'Online workshops' },
      texts: ['Approved copy', 'Draft copy'],
      usedPrompts: ['A desk'],
    })
    expect(builder('content_assets').argsFor('eq')).toEqual(['item_id', IDS.item])
  })

  it('answers 404 for an item that does not exist', async () => {
    const { db } = dbWith({ content_items: { data: null, error: null } })

    await expect(buildSuggestionContext(db as never, { kind: 'image_prompts', itemId: IDS.item })).rejects.toMatchObject({ status: 404 })
  })
})

describe('brief_completion and content_ideas', () => {
  it('passes the typed brief through with every channel on offer', async () => {
    const { db } = dbWith({})

    const context = await buildSuggestionContext(db as never, { kind: 'brief_completion', topic: 'Workshops', draft: { title: 'T' } })

    expect(context).toEqual({ topic: 'Workshops', title: 'T', channels: ['facebook', 'instagram', 'linkedin', 'email'] })
    expect(db.from).not.toHaveBeenCalled()
  })

  it('reads recent titles and unused, kept newsletter topics only', async () => {
    const { db, builder } = dbWith({
      content_items: { data: [{ title: 'Monthly workshop' }], error: null },
      newsletter_topics: { data: [{ title: 'Spring programme', details: null }], error: null },
    })

    const context = await buildSuggestionContext(db as never, { kind: 'content_ideas' })

    expect(context).toEqual({
      recentTitles: ['Monthly workshop'],
      plannedTopics: [{ title: 'Spring programme', details: null }],
      channels: ['facebook', 'instagram', 'linkedin', 'email'],
    })
    expect(builder('newsletter_topics').allFor('is').map((call) => call.args)).toEqual([
      ['used_at', null],
      ['removed_at', null],
    ])
    expect(builder('content_items').allFor('is').map((call) => call.args[0])).toEqual(['removed_at', 'archived_at'])
  })
})

it('clip leaves short text alone', () => {
  expect(clip('abc', 5)).toBe('abc')
  expect(clip('abcdef', 3)).toBe('abc')
})

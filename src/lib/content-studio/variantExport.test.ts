/** @jest-environment node */
jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({}) }))

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { CONTENT_BUCKETS } from './assets'
import { assetRow, IDS, revisionRow, storageMock } from './testFixtures'
import { exportVariant } from './variantExport'

function dbWith(tables: Record<string, unknown>) {
  return createDbMock((table: string) => createQueryBuilderMock(tables[table] ?? { data: null, error: null }))
}

function adminWithStorage() {
  const storage = storageMock()
  return { admin: Object.assign(createDbMock(createQueryBuilderMock()), { storage: storage.storage }), storage }
}

const VARIANT = { id: IDS.variant, channel: 'linkedin', current_revision_id: IDS.revision }

describe('exportVariant', () => {
  it('returns the composed text and signed image links in revision order', async () => {
    const revision = revisionRow({
      assets: [
        { assetId: IDS.asset2, alt: 'second', order: 1 },
        { assetId: IDS.asset, alt: 'first', order: 0 },
      ],
    })
    const db = dbWith({
      content_variants: { data: VARIANT, error: null },
      content_variant_revisions: { data: revision, error: null },
      content_assets: { data: [assetRow(), assetRow({ id: IDS.asset2, ingest_status: 'pending' })], error: null },
    })
    const { admin, storage } = adminWithStorage()

    const result = await exportVariant(db as never, IDS.variant, admin as never)

    expect(result).toEqual({
      channel: 'linkedin',
      revisionId: IDS.revision,
      text: 'Hello world.\n\nBook now.\n\n#AI4L',
      assets: [{ assetId: IDS.asset, alt: 'first', downloadUrl: expect.stringContaining(`library/${IDS.asset}/social`) }],
    })
    expect(storage.bucket(CONTENT_BUCKETS.library).createSignedUrls).toHaveBeenCalledWith([`library/${IDS.asset}/social`], 600)
  })

  it('exports text only for a revision without images', async () => {
    const db = dbWith({
      content_variants: { data: VARIANT, error: null },
      content_variant_revisions: { data: revisionRow({ assets: [], hashtags: null as never }), error: null },
    })
    const { admin } = adminWithStorage()

    const result = await exportVariant(db as never, IDS.variant, admin as never)

    expect(result.assets).toEqual([])
    expect(result.text).toBe('Hello world.\n\nBook now.')
    expect(db.from).not.toHaveBeenCalledWith('content_assets')
  })

  it.each([
    ['a missing variant', { content_variants: { data: null, error: null } }, 404],
    ['a variant without content', { content_variants: { data: { ...VARIANT, current_revision_id: null }, error: null } }, 409],
    ['an unreadable revision', { content_variants: { data: VARIANT, error: null }, content_variant_revisions: { data: null, error: null } }, 404],
  ])('refuses %s', async (_name, tables, status) => {
    const { admin } = adminWithStorage()
    await expect(exportVariant(dbWith(tables) as never, IDS.variant, admin as never)).rejects.toMatchObject({ status })
  })

  it('surfaces an asset read error', async () => {
    const db = dbWith({
      content_variants: { data: VARIANT, error: null },
      content_variant_revisions: { data: revisionRow(), error: null },
      content_assets: { data: null, error: { message: 'assets' } },
    })
    const { admin } = adminWithStorage()

    await expect(exportVariant(db as never, IDS.variant, admin as never)).rejects.toThrow('assets')
  })
})

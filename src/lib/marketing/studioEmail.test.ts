/**
 * @jest-environment node
 */
import { ContentHttpError } from '@/lib/content-studio/errors'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockPublish = jest.fn()
const mockSign = jest.fn()

jest.mock('@/lib/content-studio/assets', () => ({
  CONTENT_BUCKETS: { library: 'content-library' },
  displayPath: (row: { ingest_status: string; storage_path: string | null }) => (row.ingest_status === 'ready' ? row.storage_path : null),
  publishAsset: (...args: unknown[]) => mockPublish(...args),
  signDownloads: (...args: unknown[]) => mockSign(...args),
}))
jest.mock('@/lib/content-studio/repository', () => ({ getDefaultBrand: async () => ({ name: 'AI4L' }) }))
jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({ admin: true }) }))

import { createStudioEmail, proposeStudioEmail } from './studioEmail'
import type { StudioEmailRequest } from './studioEmailRequest'

const SUPABASE = 'https://proj.supabase.co'
const PUBLIC_URL = `${SUPABASE}/storage/v1/object/public/content-public/p/pub-1/sum.jpg`

const VARIANT = { id: 'var-1', item_id: 'item-1', channel: 'linkedin', current_revision_id: 'rev-1', archived_at: null }
const REVISION = {
  id: 'rev-1',
  variant_id: 'var-1',
  revision_number: 2,
  body: 'Workshop on 14 May. Link in bio.\n\nTwenty seats. #rto',
  hashtags: ['rto'],
  call_to_action: 'Save a seat',
  link_url: 'https://ai4l.com.au/workshop',
  fields: {},
  assets: [{ assetId: 'asset-1', alt: 'Room', order: 0 }],
}

const REQUEST: StudioEmailRequest = {
  idempotencyKey: 'key-123456',
  revisionId: 'rev-1',
  subject: 'Workshop',
  fields: { Preheader: 'Twenty seats', Headline: 'Workshop on 14 May', Intro: 'Join us.', Body: 'Twenty seats.', CtaLabel: 'Save a seat' },
  ctaMode: 'external_url',
  ctaUrl: 'https://ai4l.com.au/workshop',
  assets: [{ assetId: 'asset-1', alt: 'Room' }],
  templateId: 'tpl-1',
  segmentId: 'seg-1',
  campaignName: 'Workshop email',
  notes: null,
}

function setup(options: { template?: unknown; rpc?: unknown; revision?: unknown; stored?: unknown } = {}) {
  const tables: Record<string, ReturnType<typeof createQueryBuilderMock>> = {
    content_variants: createQueryBuilderMock({ data: VARIANT, error: null }),
    content_variant_revisions: createQueryBuilderMock({ data: options.revision ?? REVISION, error: null }),
    content_items: createQueryBuilderMock({ data: { id: 'item-1', title: 'May workshop' }, error: null }),
    content_assets: createQueryBuilderMock({
      data: [{ id: 'asset-1', ingest_status: 'ready', storage_path: 'library/asset-1/original.jpg', alt_text: 'Room', width: 1200, height: 800 }],
      error: null,
    }),
    campaign_templates: createQueryBuilderMock(
      options.template ?? { data: { id: 'tpl-1', archived_at: null, removed_at: null, contract_id: 'studio-static-v1', contract_version: 1 }, error: null }
    ),
    campaign_content_snapshots: createQueryBuilderMock(options.stored ?? { data: null, error: null }),
  }
  const db = createDbMock((table: string) => tables[table])
  // The snapshot RPC is service-role only: it goes through the admin client.
  const admin = { rpc: jest.fn().mockResolvedValue(options.rpc ?? { data: { snapshotId: 'snap-1', campaignId: 'camp-1', created: true, contentHash: 'h' }, error: null }) }
  return { db, tables, admin }
}

describe('studio email service', () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE
    mockPublish.mockResolvedValue({ id: 'pub-1', assetId: 'asset-1', publicUrl: PUBLIC_URL, checksum: 'sum', width: 1200, height: 800 })
    mockSign.mockResolvedValue(new Map([['library/asset-1/original.jpg', 'https://signed/preview']]))
  })
  afterAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
  })

  it('proposes an adapted email with image previews', async () => {
    const { db } = setup()

    const proposal = await proposeStudioEmail(db as never, 'var-1', {} as never)

    expect(proposal).toMatchObject({ variantId: 'var-1', itemId: 'item-1', itemTitle: 'May workshop', revisionId: 'rev-1' })
    expect(proposal.adaptation.fields.Body).not.toMatch(/#|Link in bio/)
    expect(proposal.adaptation.subject).toBe('May workshop')
    expect(proposal.assets).toEqual([{ assetId: 'asset-1', alt: 'Room', previewUrl: 'https://signed/preview', width: 1200, height: 800, ready: true }])
  })

  it('creates a static draft: publishes the image, renders, and snapshots with no per-contact fields', async () => {
    const { db, admin } = setup()

    const result = await createStudioEmail(db as never, 'var-1', 'user-1', REQUEST, 'campaign', admin as never)

    expect(mockPublish).toHaveBeenCalledWith(admin, 'asset-1', 'email', 'user-1')
    expect(db.rpc).not.toHaveBeenCalled()
    const [fn, args] = admin.rpc.mock.calls[0]
    expect(fn).toBe('create_content_email_snapshot')
    expect(args).toMatchObject({
      p_actor: 'user-1',
      p_purpose: 'campaign',
      p_source_revision_id: 'rev-1',
      p_template_id: 'tpl-1',
      p_cta_mode: 'external_url',
      p_cta_url: 'https://ai4l.com.au/workshop',
      p_fields: {},
      p_assets: [{ assetId: 'asset-1', publishedAssetId: 'pub-1', url: PUBLIC_URL, checksum: 'sum', alt: 'Room' }],
      p_campaign_name: 'Workshop email',
      p_segment_id: 'seg-1',
    })
    expect(args.p_rendered_html).toContain(`src="${PUBLIC_URL}"`)
    expect(result).toMatchObject({ snapshotId: 'snap-1', campaignId: 'camp-1', created: true })
  })

  it('snapshots the validated fields for a dynamic template', async () => {
    const { db, admin } = setup({ template: { data: { id: 'tpl-1', archived_at: null, contract_id: 'studio-newsletter-v1', contract_version: 1 }, error: null } })

    await createStudioEmail(db as never, 'var-1', 'user-1', REQUEST, 'campaign', admin as never)

    expect(admin.rpc.mock.calls[0][1].p_fields).toEqual({
      ...REQUEST.fields,
      CtaUrl: 'https://ai4l.com.au/workshop',
      HeroImageUrl: PUBLIC_URL,
      HeroImageAlt: 'Room',
    })
  })

  it('exports without a template and answers a replay with the stored HTML', async () => {
    const { db, admin } = setup({
      rpc: { data: { snapshotId: 'snap-1', campaignId: null, created: false, contentHash: 'h' }, error: null },
      stored: { data: { rendered_html: '<p>first</p>', rendered_text: 'first' }, error: null },
    })

    const result = await createStudioEmail(db as never, 'var-1', 'user-1', { ...REQUEST, templateId: null, assets: [] }, 'export', admin as never)

    expect(admin.rpc.mock.calls[0][1]).toMatchObject({ p_purpose: 'export', p_template_id: null })
    expect(result).toMatchObject({ created: false, html: '<p>first</p>', text: 'first' })
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it.each([
    ['a stale revision', () => setup(), { ...REQUEST, revisionId: 'rev-0' }, 'stale_revision'],
    ['an image from another post', () => setup(), { ...REQUEST, assets: [{ assetId: 'asset-9', alt: 'x' }] }, 'asset_mismatch'],
    [
      'a legacy template',
      () => setup({ template: { data: { id: 'tpl-1', archived_at: null, contract_id: 'legacy-v1', contract_version: 1 }, error: null } }),
      REQUEST,
      'legacy_template',
    ],
    ['a CTA the template does not allow', () => setup(), { ...REQUEST, ctaMode: 'booking' as const }, 'preflight_failed'],
    ['an http button link', () => setup(), { ...REQUEST, ctaUrl: 'http://ai4l.com.au' }, 'preflight_failed'],
    ['an over-long headline', () => setup(), { ...REQUEST, fields: { ...REQUEST.fields, Headline: 'x'.repeat(81) } }, 'preflight_failed'],
    ['a merge tag in the body', () => setup(), { ...REQUEST, fields: { ...REQUEST.fields, Body: 'Hi {{PrefsUrl}}' } }, 'preflight_failed'],
    ['markup in the intro', () => setup(), { ...REQUEST, fields: { ...REQUEST.fields, Intro: '<b>Hi</b>' } }, 'preflight_failed'],
  ])('refuses %s before publishing anything', async (_label, make, request, code) => {
    const { db, admin } = make()

    await expect(createStudioEmail(db as never, 'var-1', 'user-1', request, 'campaign', admin as never)).rejects.toMatchObject({ code })
    expect(mockPublish).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('refuses an archived template and a variant with no content', async () => {
    const archived = setup({ template: { data: { id: 'tpl-1', archived_at: '2026-01-01', contract_id: 'studio-static-v1' }, error: null } })
    await expect(createStudioEmail(archived.db as never, 'var-1', 'u', REQUEST, 'campaign', {} as never)).rejects.toBeInstanceOf(ContentHttpError)

    const empty = setup()
    empty.tables.content_variants = createQueryBuilderMock({ data: { ...VARIANT, current_revision_id: null }, error: null })
    await expect(proposeStudioEmail(empty.db as never, 'var-1', {} as never)).rejects.toMatchObject({ status: 409 })
  })

  it('passes database refusals through', async () => {
    const { db, admin } = setup({ rpc: { data: null, error: { code: 'CRM07', message: 'Every email image must be a published email copy.', hint: 'asset_not_published' } } })

    await expect(createStudioEmail(db as never, 'var-1', 'u', REQUEST, 'campaign', admin as never)).rejects.toMatchObject({ sqlState: 'CRM07', hint: 'asset_not_published' })
  })
})

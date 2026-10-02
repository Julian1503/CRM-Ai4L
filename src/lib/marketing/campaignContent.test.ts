/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { assessContent, ContentResolutionError, readCampaignContentSummary, resolveSendContent } from './campaignContent'
import { LEGACY_V1, STUDIO_NEWSLETTER_V1, STUDIO_STATIC_V1 } from './templateContracts'

const PREFIX = 'https://proj.supabase.co/storage/v1/object/public/content-public/p/'

const SNAPSHOT = {
  id: 'snap-1',
  purpose: 'campaign',
  source_revision_id: 'rev-1',
  template_id: 'tpl-1',
  contract_id: 'studio-newsletter-v1',
  contract_version: 1,
  cta_mode: 'external_url',
  cta_url: 'https://ai4l.com.au/guide',
  subject: 'Update',
  fields: {
    Preheader: 'Pre',
    Headline: 'Head',
    Intro: 'Intro',
    Body: 'Body',
    CtaLabel: 'Read',
    CtaUrl: 'https://ai4l.com.au/guide',
  },
  assets: [],
  rendered_html: '<html></html>',
  rendered_text: 'text',
  content_hash: 'hash-1',
  idempotency_key: 'key-12345',
  created_by: null,
  created_at: '2026-10-01T00:00:00Z',
}

function dbWith(tables: Record<string, unknown>) {
  const builders = Object.fromEntries(Object.entries(tables).map(([name, result]) => [name, createQueryBuilderMock(result)]))
  return createDbMock((table: string) => builders[table] ?? createQueryBuilderMock({ data: null, error: null })) as never
}

describe('resolveSendContent', () => {
  it('sends a hand-written campaign as legacy booking, without reading anything', async () => {
    const db = createDbMock(createQueryBuilderMock())
    const content = await resolveSendContent(db as never, { merge_fields: { Headline: 'Hi' }, content_snapshot_id: null })

    expect(content).toEqual({ fields: { Headline: 'Hi' }, ctaMode: 'booking', contract: LEGACY_V1, snapshot: null, contentHash: null })
    expect(db.from).not.toHaveBeenCalled()
  })

  it('sends a Studio campaign as its snapshot, never the campaign mirror', async () => {
    const db = dbWith({ campaign_content_snapshots: { data: SNAPSHOT, error: null } })
    const content = await resolveSendContent(db, { merge_fields: { Headline: 'tampered' }, content_snapshot_id: 'snap-1' })

    expect(content).toMatchObject({ fields: SNAPSHOT.fields, ctaMode: 'external_url', contract: STUDIO_NEWSLETTER_V1, contentHash: 'hash-1' })
  })

  it('refuses a missing snapshot or an unknown contract', async () => {
    await expect(resolveSendContent(dbWith({ campaign_content_snapshots: { data: null, error: null } }), { merge_fields: {}, content_snapshot_id: 's' })).rejects.toThrow(
      ContentResolutionError
    )
    await expect(
      resolveSendContent(dbWith({ campaign_content_snapshots: { data: { ...SNAPSHOT, contract_id: 'x-v9' }, error: null } }), { merge_fields: {}, content_snapshot_id: 's' })
    ).rejects.toThrow(/does not know/)
    await expect(
      resolveSendContent(dbWith({ campaign_content_snapshots: { data: null, error: { message: 'down' } } }), { merge_fields: {}, content_snapshot_id: 's' })
    ).rejects.toThrow('down')
  })
})

describe('assessContent', () => {
  const studio = { fields: SNAPSHOT.fields, ctaMode: 'external_url' as const, contract: STUDIO_NEWSLETTER_V1, snapshot: SNAPSHOT as never, contentHash: 'hash-1' }

  it('does not assess legacy campaigns', () => {
    expect(assessContent({ fields: {}, ctaMode: 'booking', contract: LEGACY_V1, snapshot: null, contentHash: null }, { dynamicEnabled: false })).toEqual([])
  })

  it('refuses dynamic fields while the flag is off, and passes when on', () => {
    expect(assessContent(studio, { dynamicEnabled: false, imagePrefix: PREFIX }).join(' ')).toMatch(/CONTENT_EMAIL_DYNAMIC_ENABLED/)
    expect(assessContent(studio, { dynamicEnabled: true, imagePrefix: PREFIX })).toEqual([])
  })

  it('passes a static automation with an external link while dynamic is off', () => {
    const snapshot = { ...SNAPSHOT, contract_id: 'studio-static-v1', fields: {} }
    expect(assessContent({ ...studio, fields: {}, contract: STUDIO_STATIC_V1, snapshot: snapshot as never }, { dynamicEnabled: false })).toEqual([])
  })

  it('refuses an export, a bad link and a field/link mismatch', () => {
    const exported = { ...SNAPSHOT, purpose: 'export' }
    expect(assessContent({ ...studio, snapshot: exported as never }, { dynamicEnabled: true, imagePrefix: PREFIX })).toContain('An HTML export cannot be sent as a campaign.')

    const mismatch = { ...SNAPSHOT, cta_url: 'https://other.example.com' }
    expect(assessContent({ ...studio, snapshot: mismatch as never }, { dynamicEnabled: true, imagePrefix: PREFIX })).toContain(
      'The button link in the fields does not match the approved link.'
    )

    const missing = { ...SNAPSHOT, cta_url: null, fields: { ...SNAPSHOT.fields, CtaUrl: undefined } }
    expect(assessContent({ ...studio, snapshot: missing as never }, { dynamicEnabled: true, imagePrefix: PREFIX }).join(' ')).toMatch(/button link is missing/)
  })
})

describe('readCampaignContentSummary', () => {
  it('describes the snapshot and finds the Studio item it came from', async () => {
    const db = dbWith({
      campaign_content_snapshots: { data: SNAPSHOT, error: null },
      content_variant_revisions: { data: { id: 'rev-1', variant_id: 'var-1', revision_number: 3 }, error: null },
      content_variants: { data: { id: 'var-1', item_id: 'item-1' }, error: null },
    })

    const summary = await readCampaignContentSummary(db, 'snap-1')

    expect(summary).toMatchObject({
      snapshotId: 'snap-1',
      contract: { id: 'studio-newsletter-v1', version: 1, delivery: 'dynamic-fields' },
      ctaMode: 'external_url',
      sourceRevisionNumber: 3,
      sourceItemId: 'item-1',
      renderedHtml: '<html></html>',
    })
  })

  it('still answers when the source revision is unreadable', async () => {
    const db = dbWith({ campaign_content_snapshots: { data: { ...SNAPSHOT, contract_id: 'gone-v1' }, error: null } })

    const summary = await readCampaignContentSummary(db, 'snap-1')

    expect(summary).toMatchObject({ sourceItemId: null, sourceRevisionNumber: null, contract: { label: 'gone-v1' } })
  })
})

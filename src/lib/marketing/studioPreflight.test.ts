/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import type { ResolvedContent } from './campaignContent'
import { studioPreflight } from './studioPreflight'
import { LEGACY_V1, STUDIO_NEWSLETTER_V1, STUDIO_STATIC_V1 } from './templateContracts'

const PREFIX = 'https://proj.supabase.co/storage/v1/object/public/content-public/p/'
const URL = `${PREFIX}pub-1/sum.jpg`

const snapshot = {
  id: 'snap-1',
  purpose: 'campaign',
  source_revision_id: 'rev-1',
  contract_id: 'studio-static-v1',
  contract_version: 1,
  cta_mode: 'none',
  cta_url: null,
  fields: {},
  assets: [{ assetId: 'asset-1', publishedAssetId: 'pub-1', url: URL, checksum: 'sum', alt: 'Room', order: 0 }],
  content_hash: 'hash-1',
}

function content(overrides: Partial<ResolvedContent> = {}): ResolvedContent {
  return { fields: {}, ctaMode: 'none', contract: STUDIO_STATIC_V1, snapshot: snapshot as never, contentHash: 'hash-1', ...overrides }
}

function db(revisionAssets: unknown = [{ assetId: 'asset-1', alt: 'Room', order: 0 }], error: unknown = null) {
  return createDbMock(createQueryBuilderMock({ data: revisionAssets === null ? null : { id: 'rev-1', assets: revisionAssets }, error })) as never
}

const credentials = { apiKey: 'k', listId: 'l' }

describe('studioPreflight', () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
  })
  afterAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
  })

  it('is not used for hand-written campaigns', async () => {
    expect(await studioPreflight(db(), content({ snapshot: null, contract: LEGACY_V1 }), { dynamicEnabled: false, credentials: null })).toBeNull()
  })

  it('passes a static email whose images belong to its revision and whose list has the fields', async () => {
    const listTags = jest.fn(async () => ({ ok: true as const, tags: ['PrefsUrl', 'Newsletter', 'Courses'] }))

    const result = await studioPreflight(db(), content(), { dynamicEnabled: false, credentials, listTags })

    expect(result).toMatchObject({ problems: [], missingFields: [], contract: 'studio-static-v1', ctaMode: 'none', contentHash: 'hash-1' })
    expect(result?.checklist.join(' ')).toMatch(/must not reference \{\{BookingUrl\}\}/)
  })

  it('flags images that are not the source revision\'s, and a missing revision', async () => {
    const foreign = await studioPreflight(db([{ assetId: 'other' }]), content(), { dynamicEnabled: false, credentials: null })
    expect(foreign?.problems).toEqual(["Image asset-1 is not one of the source revision's images."])

    const gone = await studioPreflight(db(null), content(), { dynamicEnabled: false, credentials: null })
    expect(gone?.problems.join(' ')).toMatch(/no longer exists/)

    await expect(studioPreflight(db([], { message: 'down' }), content(), { dynamicEnabled: false, credentials: null })).rejects.toThrow('down')
  })

  it('flags a hero image that is not one of the recorded images', async () => {
    const fields = { Preheader: 'p', Headline: 'h', Intro: 'i', Body: 'b', HeroImageUrl: `${PREFIX}other/x.jpg`, HeroImageAlt: 'x' }
    const result = await studioPreflight(
      db(),
      content({ contract: STUDIO_NEWSLETTER_V1, fields, snapshot: { ...snapshot, contract_id: 'studio-newsletter-v1', fields } as never }),
      { dynamicEnabled: true, credentials: null }
    )
    expect(result?.problems).toContain('The hero image is not one of the published images recorded with this email.')
  })

  it('reports missing provider fields and an unreadable list', async () => {
    const missing = await studioPreflight(db(), content(), {
      dynamicEnabled: false,
      credentials,
      listTags: async () => ({ ok: true, tags: ['PrefsUrl'] }),
    })
    expect(missing?.missingFields).toEqual(['Newsletter', 'Courses'])
    expect(missing?.problems.join(' ')).toMatch(/missing these fields: Newsletter, Courses/)

    const unreadable = await studioPreflight(db(), content(), {
      dynamicEnabled: false,
      credentials,
      listTags: async () => ({ ok: false, error: 'HTTP 401' }),
    })
    expect(unreadable?.missingFields).toBeNull()
    expect(unreadable?.problems.join(' ')).toMatch(/HTTP 401/)
  })

  it('refuses dynamic fields while the flag is off', async () => {
    const fields = { Preheader: 'p', Headline: 'h', Intro: 'i', Body: 'b' }
    const result = await studioPreflight(
      db(),
      content({ contract: STUDIO_NEWSLETTER_V1, fields, snapshot: { ...snapshot, assets: [], contract_id: 'studio-newsletter-v1', fields } as never }),
      { dynamicEnabled: false, credentials: null }
    )
    expect(result?.problems.join(' ')).toMatch(/CONTENT_EMAIL_DYNAMIC_ENABLED/)
  })
})

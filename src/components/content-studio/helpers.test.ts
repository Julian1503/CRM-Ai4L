import { isSuperseded, visibleGenerationJobs, retryChannels } from './GenerationProgress'
import { composePostText } from './composePostText'
import { formatDateTime, isSocialChannel, isTerminal, parseHashtags, parseHttpsUrl } from './labels'
import { assetLabel, contentOf, moveRef, normaliseOrder, previewImages } from './revision'
import { foldText, instagramAspect } from './SocialPreview'
import { makeAsset, makeJob, makeRevision } from './testUtils'

describe('composePostText', () => {
  it('joins body, CTA and hashtags with blank lines', () => {
    expect(composePostText({ body: ' Body ', callToAction: ' Book ', hashtags: ['#a', ' #b ', ''] })).toBe('Body\n\nBook\n\n#a #b')
  })

  it('drops empty sections', () => {
    expect(composePostText({ body: 'Body', callToAction: null, hashtags: [] })).toBe('Body')
    expect(composePostText({ body: '', callToAction: '', hashtags: ['#x'] })).toBe('#x')
  })
})

describe('labels helpers', () => {
  it('accepts only https URLs', () => {
    expect(parseHttpsUrl('https://example.com/a')?.hostname).toBe('example.com')
    expect(parseHttpsUrl('http://example.com')).toBeNull()
    expect(parseHttpsUrl('javascript:alert(1)')).toBeNull()
    expect(parseHttpsUrl('not a url')).toBeNull()
  })

  it('normalises hashtags', () => {
    expect(parseHashtags('#one, two  ##three #one')).toEqual(['#one', '#two', '#three'])
    expect(parseHashtags('   ')).toEqual([])
  })

  it('formats dates and handles missing ones', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('garbage')).toBe('—')
    expect(formatDateTime('2026-09-30T10:00:00Z')).toMatch(/2026/)
  })

  it('knows terminal statuses and social channels', () => {
    expect(isTerminal('uncertain')).toBe(true)
    expect(isTerminal('running')).toBe(false)
    expect(isSocialChannel('email')).toBe(false)
    expect(isSocialChannel('linkedin')).toBe(true)
  })
})

describe('revision helpers', () => {
  it('copies revision content without sharing references', () => {
    const revision = makeRevision({ fields: { subject: 'S' }, assets: [{ assetId: 'a', alt: 'x', order: 0 }] })
    const content = contentOf(revision)
    content.fields.subject = 'changed'
    content.assets[0].alt = 'changed'
    expect(revision.fields.subject).toBe('S')
    expect(revision.assets[0].alt).toBe('x')
    expect(contentOf(null)).toEqual({ body: '', hashtags: [], callToAction: null, linkUrl: null, fields: {}, assets: [] })
  })

  it('renumbers and moves refs', () => {
    const refs = [
      { assetId: 'b', alt: '', order: 5 },
      { assetId: 'a', alt: '', order: 1 },
    ]
    expect(normaliseOrder(refs).map((ref) => [ref.assetId, ref.order])).toEqual([
      ['a', 0],
      ['b', 1],
    ])
    expect(moveRef(refs, 'b', -1).map((ref) => ref.assetId)).toEqual(['b', 'a'])
    expect(moveRef(refs, 'a', -1).map((ref) => ref.assetId)).toEqual(['a', 'b'])
    expect(moveRef(refs, 'missing', 1).map((ref) => ref.assetId)).toEqual(['a', 'b'])
  })

  it('builds preview images, tolerating missing assets', () => {
    const images = previewImages(
      [
        { assetId: 'asset-1', alt: 'one', order: 0 },
        { assetId: 'gone', alt: 'two', order: 1 },
      ],
      [makeAsset()]
    )
    expect(images[0]).toMatchObject({ url: 'https://storage.test/preview/asset-1.jpg', width: 1200 })
    expect(images[1]).toMatchObject({ url: null, width: null, alt: 'two' })
  })

  it('labels assets by filename, prompt, alt, then a default', () => {
    expect(assetLabel(makeAsset())).toBe('workshop.jpg')
    expect(assetLabel(makeAsset({ originalFilename: null, generationPrompt: 'a cat' }))).toBe('a cat')
    expect(assetLabel(makeAsset({ originalFilename: null, altText: 'alt' }))).toBe('alt')
    expect(assetLabel(makeAsset({ originalFilename: null, altText: '' }))).toBe('Image')
  })
})

describe('preview helpers', () => {
  it('folds long text on a word boundary', () => {
    expect(foldText('short', 10)).toEqual({ head: 'short', tail: '' })
    expect(foldText('aaaa bbbb cccc', 12)).toEqual({ head: 'aaaa bbbb', tail: ' cccc' })
    expect(foldText('abcdefghijkl', 5)).toEqual({ head: 'abcde', tail: 'fghijkl' })
  })

  it('clamps the Instagram aspect ratio', () => {
    expect(instagramAspect(undefined)).toBe(1)
    expect(instagramAspect({ id: 'a', url: null, alt: '', width: 100, height: 1000 })).toBe(0.8)
    expect(instagramAspect({ id: 'a', url: null, alt: '', width: 1000, height: 100 })).toBe(1.91)
  })
})

describe('generation job selection', () => {
  it('shows running and problematic jobs, newest first, including image processing', () => {
    const jobs = [
      makeJob({ id: 'ok', status: 'succeeded', createdAt: '2026-01-01' }),
      makeJob({ id: 'partial', status: 'succeeded', createdAt: '2026-01-02', failures: [{ channel: 'email', errorCode: 'x', message: 'm' }] }),
      makeJob({ id: 'run', kind: 'generate_image', status: 'running', createdAt: '2026-01-03' }),
      makeJob({ id: 'ingest', kind: 'ingest_asset', status: 'failed', createdAt: '2026-01-04' }),
      makeJob({ id: 'publish', kind: 'publish_social', status: 'failed' }),
    ]
    expect(visibleGenerationJobs(jobs).map((job) => job.id)).toEqual(['ingest', 'run', 'partial'])
  })

  it('hides finished jobs superseded by newer work of the same kind', () => {
    const failed = makeJob({ id: 'old', status: 'failed', createdAt: '2026-01-01' })
    const newer = makeJob({ id: 'new', status: 'succeeded', createdAt: '2026-01-02' })
    const otherVariant = makeJob({ id: 'regen', status: 'succeeded', variantId: 'var-9', createdAt: '2026-01-03' })
    expect(isSuperseded(failed, [failed, newer])).toBe(true)
    expect(isSuperseded(failed, [failed, otherVariant])).toBe(false)
    expect(isSuperseded(makeJob({ status: 'running' }), [newer])).toBe(false)
    const ingest = makeJob({ id: 'i1', kind: 'ingest_asset', status: 'failed', createdAt: '2026-01-01' })
    expect(isSuperseded(ingest, [ingest, makeJob({ id: 'i2', kind: 'ingest_asset', createdAt: '2026-01-02' })])).toBe(false)
    const image = makeJob({ id: 'g1', kind: 'generate_image', status: 'failed', createdAt: '2026-01-01', variantId: 'a' })
    expect(isSuperseded(image, [image, makeJob({ id: 'g2', kind: 'generate_image', createdAt: '2026-01-02', variantId: 'b' })])).toBe(true)
  })

  it('retries failed channels, or everything after an outright failure', () => {
    expect(retryChannels(makeJob({ status: 'succeeded', failures: [{ channel: 'email', errorCode: 'x', message: 'm' }, { channel: 'email', errorCode: 'y', message: 'n' }] }), ['facebook'])).toEqual(['email'])
    expect(retryChannels(makeJob({ status: 'failed' }), ['facebook', 'linkedin'])).toEqual(['facebook', 'linkedin'])
    expect(retryChannels(makeJob({ status: 'uncertain' }), ['facebook'])).toEqual([])
    expect(retryChannels(makeJob({ kind: 'generate_image', status: 'failed' }), ['facebook'])).toEqual([])
  })
})

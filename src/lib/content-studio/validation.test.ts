/** @jest-environment node */
import {
  isHttpsUrl,
  isRecord,
  parseBrief,
  parseChannels,
  parseCreateItem,
  parseCreateUpload,
  parseDuplicateVariant,
  parseGenerate,
  parseGenerateImages,
  parseResolveJob,
  parseReview,
  parseRevisionContent,
  parseSaveRevision,
  parseUpdateAsset,
  parseUpdateItem,
  parseUpdateVariant,
  parseBrandUpdate,
  readIdempotencyKey,
} from './validation'

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const KEY = 'key-12345678'

function error(result: { ok: boolean; error?: string }) {
  return result.ok ? null : result.error
}

describe('primitives', () => {
  it('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
  })

  it('isHttpsUrl accepts https only', () => {
    expect(isHttpsUrl('https://ai4l.example/x')).toBe(true)
    expect(isHttpsUrl('http://ai4l.example')).toBe(false)
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpsUrl('not a url')).toBe(false)
  })

  it('readIdempotencyKey enforces 8..200 safe characters', () => {
    expect(readIdempotencyKey({ idempotencyKey: 'ingest:' + UUID })).toEqual({ ok: true, value: 'ingest:' + UUID })
    expect(error(readIdempotencyKey({ idempotencyKey: 'short' }))).toMatch(/idempotencyKey/)
    expect(error(readIdempotencyKey({ idempotencyKey: 'x'.repeat(201) }))).toMatch(/idempotencyKey/)
    expect(error(readIdempotencyKey({ idempotencyKey: 'has spaces here' }))).toMatch(/idempotencyKey/)
    expect(error(readIdempotencyKey({}))).toMatch(/idempotencyKey/)
  })

  it('parseChannels keeps canonical order and refuses unknown or repeated channels', () => {
    expect(parseChannels(['email', 'facebook'])).toEqual({ ok: true, value: ['facebook', 'email'] })
    expect(error(parseChannels([]))).toMatch(/at least one/)
    expect(error(parseChannels('facebook'))).toMatch(/at least one/)
    expect(error(parseChannels(['tiktok']))).toMatch(/among/)
    expect(error(parseChannels(['email', 'email']))).toMatch(/once/)
  })
})

describe('parseBrief', () => {
  it('keeps only given fields and trims them', () => {
    expect(parseBrief({ topic: ' AI ', notes: 'n', referenceUrl: 'https://x.example', sourceFacts: ['a'] })).toEqual({
      ok: true,
      value: { topic: 'AI', notes: 'n', referenceUrl: 'https://x.example', sourceFacts: ['a'] },
    })
  })

  it('treats an empty reference URL as absent', () => {
    expect(parseBrief({ topic: 'AI', referenceUrl: '' })).toEqual({ ok: true, value: { topic: 'AI' } })
    expect(parseBrief({ topic: 'AI', referenceUrl: null })).toEqual({ ok: true, value: { topic: 'AI' } })
  })

  it.each([
    [null, /object/],
    [{}, /topic is required/],
    [{ topic: '  ' }, /topic is required/],
    [{ topic: 5 }, /string/],
    [{ topic: 'x'.repeat(501) }, /at most 500/],
    [{ topic: 'AI', referenceUrl: 'http://insecure.example' }, /https/],
    [{ topic: 'AI', sourceFacts: 'fact' }, /list/],
    [{ topic: 'AI', sourceFacts: [1] }, /entry/],
  ])('refuses %p', (brief, message) => {
    expect(error(parseBrief(brief))).toMatch(message)
  })
})

describe('items', () => {
  it('parseCreateItem accepts a complete request', () => {
    expect(parseCreateItem({ title: ' Launch ', brief: { topic: 'AI' }, channels: ['linkedin'] })).toEqual({
      ok: true,
      value: { title: 'Launch', brief: { topic: 'AI' }, channels: ['linkedin'] },
    })
    expect(error(parseCreateItem({ brief: { topic: 'AI' }, channels: ['linkedin'] }))).toMatch(/title/)
  })

  it('parseUpdateItem needs something to change', () => {
    expect(parseUpdateItem({ archived: true })).toEqual({ ok: true, value: { archived: true } })
    expect(parseUpdateItem({ title: 'New', channels: ['email'], brief: { topic: 'b' } })).toEqual({
      ok: true,
      value: { title: 'New', channels: ['email'], brief: { topic: 'b' } },
    })
    expect(error(parseUpdateItem({}))).toMatch(/Nothing/)
    expect(error(parseUpdateItem({ archived: 'yes' }))).toMatch(/archived/)
    expect(error(parseUpdateItem({ channels: [] }))).toMatch(/channel/)
  })
})

describe('generation', () => {
  it('parseGenerate defaults to one style and needs a pair for regeneration', () => {
    expect(parseGenerate({ idempotencyKey: KEY, channels: ['facebook'] })).toEqual({
      ok: true,
      value: { idempotencyKey: KEY, channels: ['facebook'], stylesPerChannel: 1 },
    })
    expect(
      parseGenerate({ idempotencyKey: KEY, channels: ['email'], variantId: UUID, baseRevisionId: UUID2, instruction: 'shorter', stylesPerChannel: 2 })
    ).toMatchObject({ ok: true, value: { variantId: UUID, baseRevisionId: UUID2, instruction: 'shorter', stylesPerChannel: 2 } })
    expect(error(parseGenerate({ idempotencyKey: KEY, channels: ['email'], variantId: UUID }))).toMatch(/both/)
    expect(error(parseGenerate({ idempotencyKey: KEY, channels: ['email', 'facebook'], variantId: UUID, baseRevisionId: UUID2 }))).toMatch(
      /exactly one/
    )
    expect(error(parseGenerate({ idempotencyKey: KEY, channels: ['email'], stylesPerChannel: 4 }))).toMatch(/stylesPerChannel/)
    expect(error(parseGenerate({ idempotencyKey: KEY, channels: ['email'], variantId: 'x', baseRevisionId: UUID }))).toMatch(/UUID/)
  })

  it('parseGenerateImages bounds count and quality', () => {
    expect(parseGenerateImages({ idempotencyKey: KEY, prompt: 'a cat', count: 2 })).toEqual({
      ok: true,
      value: { idempotencyKey: KEY, prompt: 'a cat', count: 2, quality: 'medium' },
    })
    expect(error(parseGenerateImages({ idempotencyKey: KEY, prompt: 'a', count: 5 }))).toMatch(/count/)
    expect(error(parseGenerateImages({ idempotencyKey: KEY, prompt: 'a', count: 1, quality: 'ultra' }))).toMatch(/quality/)
    expect(error(parseGenerateImages({ idempotencyKey: KEY, prompt: ' ', count: 1 }))).toMatch(/prompt/)
  })
})

describe('revisions', () => {
  const content = {
    body: ' Body keeps its spacing ',
    hashtags: ['AI4L'],
    callToAction: '',
    linkUrl: 'https://ai4l.example',
    fields: { subject: 'Hi' },
    assets: [{ assetId: UUID, alt: 'A' }, { assetId: UUID2, order: 5 }],
  }

  it('parseRevisionContent normalises optional parts', () => {
    expect(parseRevisionContent(content)).toEqual({
      ok: true,
      value: {
        body: ' Body keeps its spacing ',
        hashtags: ['AI4L'],
        callToAction: null,
        linkUrl: 'https://ai4l.example',
        fields: { subject: 'Hi' },
        assets: [
          { assetId: UUID, alt: 'A', order: 0 },
          { assetId: UUID2, alt: '', order: 5 },
        ],
      },
    })
    expect(parseRevisionContent({ body: '' })).toEqual({
      ok: true,
      value: { body: '', hashtags: [], callToAction: null, linkUrl: null, fields: {}, assets: [] },
    })
  })

  it.each([
    ['not an object', 'x', /object/],
    ['no body', {}, /body/],
    ['too many images', { body: '', assets: new Array(11).fill({ assetId: UUID }) }, /at most 10/],
    ['bad image', { body: '', assets: [{ assetId: 'x' }] }, /assetId/],
    ['repeated image', { body: '', assets: [{ assetId: UUID }, { assetId: UUID }] }, /once/],
    ['bad field', { body: '', fields: { '1x': 'y' } }, /field/],
    ['fields not object', { body: '', fields: [] }, /fields/],
    ['http link', { body: '', linkUrl: 'http://x.example' }, /https/],
  ])('refuses %s', (_name, raw, message) => {
    expect(error(parseRevisionContent(raw))).toMatch(message)
  })

  it('parseSaveRevision requires an explicit expected revision', () => {
    expect(parseSaveRevision({ idempotencyKey: KEY, expectedRevisionId: null, content: { body: 'x' } })).toMatchObject({
      ok: true,
      value: { expectedRevisionId: null },
    })
    expect(error(parseSaveRevision({ idempotencyKey: KEY, content: { body: 'x' } }))).toMatch(/expectedRevisionId/)
    expect(error(parseSaveRevision({ idempotencyKey: KEY, expectedRevisionId: UUID, content: null }))).toMatch(/content/)
  })

  it('parseDuplicateVariant needs a key', () => {
    expect(parseDuplicateVariant({ idempotencyKey: KEY })).toEqual({ ok: true, value: { idempotencyKey: KEY } })
    expect(error(parseDuplicateVariant({}))).toMatch(/idempotencyKey/)
  })

  it('parseReview requires a reason to reject', () => {
    expect(parseReview({ revisionId: UUID, decision: 'approved' })).toEqual({ ok: true, value: { revisionId: UUID, decision: 'approved' } })
    expect(parseReview({ revisionId: UUID, decision: 'rejected', reason: ' off-brand ' })).toEqual({
      ok: true,
      value: { revisionId: UUID, decision: 'rejected', reason: 'off-brand' },
    })
    expect(error(parseReview({ revisionId: UUID, decision: 'rejected' }))).toMatch(/why/)
    expect(error(parseReview({ revisionId: 'x', decision: 'approved' }))).toMatch(/revisionId/)
    expect(error(parseReview({ revisionId: UUID, decision: 'maybe' }))).toMatch(/decision/)
    expect(error(parseReview({ revisionId: UUID, decision: 'approved', reason: 3 }))).toMatch(/string/)
  })
})

describe('assets and jobs', () => {
  it('parseCreateUpload enforces the allowlist and size', () => {
    expect(parseCreateUpload({ filename: 'a.png', mimeType: 'image/png', byteSize: 10, itemId: UUID })).toEqual({
      ok: true,
      value: { filename: 'a.png', mimeType: 'image/png', byteSize: 10, itemId: UUID },
    })
    expect(error(parseCreateUpload({ filename: 'a.svg', mimeType: 'image/svg+xml', byteSize: 10 }))).toMatch(/JPEG/)
    expect(error(parseCreateUpload({ filename: 'a.png', mimeType: 'image/png', byteSize: 16 * 1024 * 1024 }))).toMatch(/15 MiB/)
    expect(error(parseCreateUpload({ filename: 'a.png', mimeType: 'image/png', byteSize: 1.5 }))).toMatch(/15 MiB/)
    expect(error(parseCreateUpload({ mimeType: 'image/png', byteSize: 1 }))).toMatch(/filename/)
  })

  it('parseUpdateAsset accepts alt text and archiving', () => {
    expect(parseUpdateAsset({ altText: ' A dog ', archived: false })).toEqual({ ok: true, value: { altText: 'A dog', archived: false } })
    expect(error(parseUpdateAsset({}))).toMatch(/Nothing/)
    expect(error(parseUpdateAsset({ archived: 1 }))).toMatch(/archived/)
    expect(error(parseUpdateAsset({ altText: 'x'.repeat(501) }))).toMatch(/500/)
  })

  it('parseResolveJob requires a note and an https permalink', () => {
    expect(parseResolveJob({ resolution: 'succeeded', note: 'Checked the page', externalId: '123', permalink: 'https://fb.example/p' })).toEqual({
      ok: true,
      value: { resolution: 'succeeded', note: 'Checked the page', externalId: '123', permalink: 'https://fb.example/p' },
    })
    expect(parseResolveJob({ resolution: 'failed', note: 'Not there' })).toEqual({ ok: true, value: { resolution: 'failed', note: 'Not there' } })
    expect(error(parseResolveJob({ resolution: 'maybe', note: 'x' }))).toMatch(/resolution/)
    expect(error(parseResolveJob({ resolution: 'failed', note: '' }))).toMatch(/note/)
    expect(error(parseResolveJob({ resolution: 'failed', note: 'x', permalink: 'http://x' }))).toMatch(/https/)
  })
})

describe('parseUpdateVariant', () => {
  it('needs a boolean archived flag', () => {
    expect(parseUpdateVariant({ archived: true })).toEqual({ ok: true, value: { archived: true } })
    expect(error(parseUpdateVariant({}))).toMatch(/archived/)
  })
})

describe('parseBrandUpdate', () => {
  it('normalises a full update', () => {
    expect(
      parseBrandUpdate({
        name: ' AI4L ',
        tone: 'Plain',
        approvedFacts: [{ id: ' f1 ', text: ' Fact ', source: ' ' }, { id: 'f2', text: 'Other', source: 'Site' }],
        channelRules: { linkedin: { cta: ' Book ', structure: '' } },
        hashtagSeeds: ['AI4L'],
        allowedLinkOrigins: ['HTTPS://AI4L.example/', 'https://ai4l.example', 'https://book.ai4l.example:8443'],
      })
    ).toEqual({
      ok: true,
      value: {
        name: 'AI4L',
        tone: 'Plain',
        approvedFacts: [{ id: 'f1', text: 'Fact' }, { id: 'f2', text: 'Other', source: 'Site' }],
        channelRules: { linkedin: { cta: 'Book' } },
        hashtagSeeds: ['AI4L'],
        allowedLinkOrigins: ['https://ai4l.example', 'https://book.ai4l.example:8443'],
      },
    })
  })

  it.each([
    [{}, /Nothing/],
    [{ name: '' }, /name/],
    [{ approvedFacts: 'x' }, /at most 100/],
    [{ approvedFacts: new Array(101).fill({ id: 'a', text: 'b' }) }, /at most 100/],
    [{ approvedFacts: [{ id: 'a', text: '' }] }, /approved fact/],
    [{ approvedFacts: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }, /unique/],
    [{ approvedFacts: [{ id: 'a', text: 'x', source: 5 }] }, /approved fact/],
    [{ channelRules: [] }, /object/],
    [{ channelRules: { tiktok: {} } }, /may only name/],
    [{ channelRules: { email: { cta: 'x'.repeat(301) } } }, /300/],
    [{ channelRules: { email: 'x' } }, /300/],
    [{ allowedLinkOrigins: ['https://ai4l.example/path'] }, /without a path/],
    [{ allowedLinkOrigins: ['http://ai4l.example'] }, /without a path/],
    [{ allowedLinkOrigins: [5] }, /without a path/],
    [{ allowedLinkOrigins: 'https://ai4l.example' }, /at most 20/],
    [{ hashtagSeeds: [1] }, /entry/],
  ])('refuses %p', (body, message) => {
    expect(error(parseBrandUpdate(body as never))).toMatch(message)
  })
})

import { parseStudioEmailRequest } from './studioEmailRequest'

const REVISION = '11111111-1111-4111-8111-111111111111'
const TEMPLATE = '22222222-2222-4222-8222-222222222222'
const ASSET = '33333333-3333-4333-8333-333333333333'

const BODY = {
  idempotencyKey: 'key-123456',
  revisionId: REVISION,
  templateId: TEMPLATE,
  campaignName: ' June news ',
  subject: ' Update ',
  ctaMode: 'external_url',
  ctaUrl: ' https://ai4l.com.au ',
  fields: { Preheader: 'p', Headline: 'h', Intro: 'i', Body: 'b', CtaLabel: 'Go', Extra: 'dropped', BookingUrl: 'x' },
  assets: [{ assetId: ASSET, alt: ' Room ' }],
}

describe('parseStudioEmailRequest', () => {
  it('reads a campaign request and keeps only the email slots', () => {
    const parsed = parseStudioEmailRequest(BODY, 'campaign')

    expect(parsed).toEqual({
      ok: true,
      value: {
        idempotencyKey: 'key-123456',
        revisionId: REVISION,
        subject: 'Update',
        fields: { Preheader: 'p', Headline: 'h', Intro: 'i', Body: 'b', CtaLabel: 'Go' },
        ctaMode: 'external_url',
        ctaUrl: 'https://ai4l.com.au',
        assets: [{ assetId: ASSET, alt: 'Room' }],
        templateId: TEMPLATE,
        segmentId: null,
        campaignName: 'June news',
        notes: null,
      },
    })
  })

  it('drops template, segment and name for an export', () => {
    const parsed = parseStudioEmailRequest({ ...BODY, segmentId: TEMPLATE }, 'export')
    expect(parsed).toMatchObject({ ok: true, value: { templateId: null, segmentId: null, campaignName: null } })
  })

  it.each([
    ['no idempotency key', { idempotencyKey: 'x' }, /idempotency/],
    ['no revision', { revisionId: 'nope' }, /revision/],
    ['an unknown CTA', { ctaMode: 'link' }, /call to action/],
    ['no fields', { fields: 'x' }, /fields/],
    ['two images', { assets: [{ assetId: ASSET, alt: 'a' }, { assetId: ASSET, alt: 'b' }] }, /at most 1/],
    ['an image without alt', { assets: [{ assetId: ASSET, alt: ' ' }] }, /alt text/],
    ['a bad image id', { assets: [{ assetId: 'x', alt: 'a' }] }, /assetId/],
    ['assets not a list', { assets: 'x' }, /list/],
    ['a long alt', { assets: [{ assetId: ASSET, alt: 'x'.repeat(201) }] }, /200/],
    ['a bad template id', { templateId: 'x' }, /Unknown template/],
    ['no template', { templateId: '' }, /template/],
    ['no name', { campaignName: ' ' }, /name/],
    ['a long name', { campaignName: 'x'.repeat(201) }, /200/],
    ['no subject', { subject: '' }, /subject/],
    ['a long subject', { subject: 'x'.repeat(91) }, /90/],
    ['a merge tag in the subject', { subject: 'Hi {{Headline}}' }, /must not contain/],
  ])('refuses %s', (_label, change, message) => {
    expect(parseStudioEmailRequest({ ...BODY, ...change }, 'campaign')).toEqual({ ok: false, error: expect.stringMatching(message) })
  })

  it('refuses a booking button on an export', () => {
    expect(parseStudioEmailRequest({ ...BODY, ctaMode: 'booking' }, 'export')).toEqual({ ok: false, error: expect.stringMatching(/booking/) })
  })
})

import { buildCopyToolSchema, CAMPAIGN_COPY_FIELDS, findMissingMergeFields, validateCampaignCopy } from './mergeFields'
import {
  buildToolSchema,
  contentPublicPrefix,
  deliveryProblem,
  findContract,
  findMissingContractFields,
  generatedSlots,
  imageProblem,
  isCtaMode,
  isStudioContract,
  LEGACY_V1,
  linkProblem,
  requiredProviderFields,
  resolveContract,
  STUDIO_NEWSLETTER_V1,
  STUDIO_STATIC_V1,
  stripReservedFields,
  templateChecklist,
  UnknownContractError,
  validateCopy,
} from './templateContracts'

const PREFIX = 'https://proj.supabase.co/storage/v1/object/public/content-public/p/'
const IMAGE = `${PREFIX}0b4f7f36-5a39-4c3b-a2fb-3f1d5fd0e0a1/abc123.jpg`

const LEGACY_COPY = Object.fromEntries(CAMPAIGN_COPY_FIELDS.map((field) => [field.tag, `${field.tag} text`]))

const STUDIO_COPY = {
  Preheader: 'What changes for you this term.',
  Headline: 'New training rules',
  Intro: 'A short update.',
  Body: 'Here is what you need to know.',
  CtaLabel: 'Read the guide',
  CtaUrl: 'https://ai4l.com.au/guide',
}

describe('legacy-v1 stays byte-for-byte the old contract', () => {
  it.each([
    ['complete copy', LEGACY_COPY],
    ['a missing field', { ...LEGACY_COPY, Benefit2: undefined }],
    ['an empty field', { ...LEGACY_COPY, Intro: '   ' }],
    ['an over-long field', { ...LEGACY_COPY, CtaLabel: 'x'.repeat(29) }],
    ['a non-string', { ...LEGACY_COPY, Headline: 5 }],
    ['a reserved field', { ...LEGACY_COPY, BookingUrl: 'https://evil' }],
    ['an unknown field', { ...LEGACY_COPY, Extra: 'x' }],
    ['not an object', ['a']],
    ['null', null],
  ])('validates %s exactly like validateCampaignCopy', (_label, input) => {
    expect(validateCopy(LEGACY_V1, input)).toEqual(validateCampaignCopy(input))
  })

  it('builds the same tool schema and provider requirement', () => {
    expect(buildToolSchema(LEGACY_V1)).toEqual(buildCopyToolSchema())
    expect(findMissingContractFields(LEGACY_V1, [])).toEqual(findMissingMergeFields([]))
  })

  it('is what a template without a contract resolves to', () => {
    expect(resolveContract(null)).toBe(LEGACY_V1)
    expect(resolveContract({})).toBe(LEGACY_V1)
    expect(resolveContract({ contract_id: 'legacy-v1', contract_version: 1 })).toBe(LEGACY_V1)
    expect(isStudioContract(LEGACY_V1)).toBe(false)
  })
})

describe('resolving contracts', () => {
  it('finds the Studio contracts and refuses unknown ones', () => {
    expect(findContract('studio-newsletter-v1')).toBe(STUDIO_NEWSLETTER_V1)
    expect(findContract('studio-static-v1', 1)).toBe(STUDIO_STATIC_V1)
    expect(findContract('studio-static-v1', 2)).toBeNull()
    expect(() => resolveContract({ contract_id: 'nope-v9', contract_version: 1 })).toThrow(UnknownContractError)
  })

  it('never makes a reserved field a slot', () => {
    for (const contract of [LEGACY_V1, STUDIO_NEWSLETTER_V1, STUDIO_STATIC_V1]) {
      const tags = contract.slots.map((slot) => slot.tag)
      expect(tags).not.toEqual(expect.arrayContaining(['BookingUrl']))
      expect(tags).not.toContain('PrefsUrl')
      expect(tags).not.toContain('Newsletter')
      expect(tags).not.toContain('Courses')
    }
  })

  it('recognises CTA modes', () => {
    expect(isCtaMode('external_url')).toBe(true)
    expect(isCtaMode('link')).toBe(false)
  })
})

describe('studio-newsletter-v1 validation', () => {
  const options = { ctaMode: 'external_url' as const, imagePrefix: PREFIX }

  it('accepts valid content with a published image and alt', () => {
    const result = validateCopy(STUDIO_NEWSLETTER_V1, { ...STUDIO_COPY, HeroImageUrl: IMAGE, HeroImageAlt: 'A classroom' }, options)
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ HeroImageUrl: IMAGE, CtaUrl: STUDIO_COPY.CtaUrl }) })
  })

  it.each([
    ['http link', 'http://ai4l.com.au'],
    ['localhost', 'https://localhost/x'],
    ['private address', 'https://192.168.1.4/x'],
    ['credentials', 'https://user:pw@ai4l.com.au'],
    ['javascript', 'javascript:alert(1)'],
    ['spaces', 'https://ai4l.com.au/a b'],
  ])('refuses a button link that is %s', (_label, url) => {
    const result = validateCopy(STUDIO_NEWSLETTER_V1, { ...STUDIO_COPY, CtaUrl: url }, options)
    expect(result.ok).toBe(false)
  })

  it.each([
    ['a remote image', 'https://example.com/a.jpg'],
    ['a signed preview', 'https://proj.supabase.co/storage/v1/object/sign/content-library/x.jpg?token=1'],
    ['a blob', 'blob:https://crm/1'],
    ['embedded data', 'data:image/png;base64,AAAA'],
    ['a traversal', `${PREFIX}../secret.jpg`],
    ['the bare prefix', PREFIX],
  ])('refuses %s as the hero image', (_label, url) => {
    const result = validateCopy(STUDIO_NEWSLETTER_V1, { ...STUDIO_COPY, HeroImageUrl: url, HeroImageAlt: 'x' }, options)
    expect(result).toEqual({ ok: false, errors: [expect.stringMatching(/^HeroImageUrl/)] })
  })

  it('cannot check images without a configured origin', () => {
    const result = validateCopy(STUDIO_NEWSLETTER_V1, { ...STUDIO_COPY, HeroImageUrl: IMAGE, HeroImageAlt: 'x' }, { ...options, imagePrefix: null })
    expect(result).toEqual({ ok: false, errors: [expect.stringMatching(/NEXT_PUBLIC_SUPABASE_URL/)] })
  })

  it('requires alt text with an image', () => {
    const result = validateCopy(STUDIO_NEWSLETTER_V1, { ...STUDIO_COPY, HeroImageUrl: IMAGE }, options)
    expect(result).toEqual({ ok: false, errors: [expect.stringMatching(/HeroImageAlt is required/)] })
  })

  it('requires the link for external_url and refuses it (and the label) without a button', () => {
    expect(validateCopy(STUDIO_NEWSLETTER_V1, { ...STUDIO_COPY, CtaUrl: undefined }, options)).toEqual({ ok: false, errors: ['CtaUrl is missing.'] })
    const none = validateCopy(STUDIO_NEWSLETTER_V1, STUDIO_COPY, { ctaMode: 'none', imagePrefix: PREFIX })
    expect(none).toEqual({ ok: false, errors: ['CtaLabel is not used with this call to action.', 'CtaUrl is not used with this call to action.'] })
    const plain = { Preheader: STUDIO_COPY.Preheader, Headline: STUDIO_COPY.Headline, Intro: STUDIO_COPY.Intro, Body: STUDIO_COPY.Body }
    expect(validateCopy(STUDIO_NEWSLETTER_V1, plain, { ctaMode: 'none', imagePrefix: PREFIX }).ok).toBe(true)
  })

  it('refuses reserved and unknown keys, and optional non-text values', () => {
    const result = validateCopy(STUDIO_NEWSLETTER_V1, { ...STUDIO_COPY, PrefsUrl: 'x', Other: 'y', HeroImageAlt: 3 }, options)
    expect(result).toEqual({
      ok: false,
      errors: ['HeroImageAlt must be text.', 'PrefsUrl is set at send time and cannot be generated.', 'Other is not a field this template merges.'],
    })
  })

  it.each(['Hi {{PrefsUrl}}', 'closing }} braces', '<script>x</script>', 'a > b'])(
    'refuses merge tags and markup in Studio text: %s',
    (text) => {
      const result = validateCopy(STUDIO_NEWSLETTER_V1, { ...STUDIO_COPY, Body: text }, options)
      expect(result).toEqual({ ok: false, errors: ['Body must not contain {{, }}, < or >.'] })
    }
  )

  it('leaves legacy-v1 text rules as they were', () => {
    expect(validateCopy(LEGACY_V1, { ...LEGACY_COPY, Intro: 'Under <10 staff' }).ok).toBe(true)
  })

  it('allows a partial draft but still checks shape', () => {
    expect(validateCopy(STUDIO_NEWSLETTER_V1, { Headline: 'Hi' }, { partial: true })).toEqual({ ok: true, value: { Headline: 'Hi' } })
    expect(validateCopy(LEGACY_V1, { Headline: 'x'.repeat(81) }, { partial: true }).ok).toBe(false)
  })

  it('refuses a CTA mode the contract does not support', () => {
    const result = validateCopy(STUDIO_STATIC_V1, {}, { ctaMode: 'booking' })
    expect(result).toEqual({ ok: false, errors: ['This template does not support the "booking" call to action.'] })
  })

  it('never asks the model for URLs or alt text', () => {
    expect(generatedSlots(STUDIO_NEWSLETTER_V1, 'external_url').map((slot) => slot.tag)).toEqual(['Preheader', 'Headline', 'Intro', 'Body', 'CtaLabel'])
    expect(buildToolSchema(STUDIO_NEWSLETTER_V1, 'none').required).toEqual(['Preheader', 'Headline', 'Intro', 'Body'])
  })
})

describe('provider fields and delivery', () => {
  it('needs BookingUrl only for booking', () => {
    expect(requiredProviderFields(STUDIO_NEWSLETTER_V1, 'external_url')).not.toContain('BookingUrl')
    expect(requiredProviderFields(STUDIO_NEWSLETTER_V1, 'booking')).toContain('BookingUrl')
    expect(requiredProviderFields(STUDIO_STATIC_V1)).toEqual(['PrefsUrl', 'Newsletter', 'Courses'])
    expect(findMissingContractFields(STUDIO_STATIC_V1, ['prefsurl', 'Newsletter'])).toEqual(['Courses'])
  })

  it('keeps dynamic fields off until the flag, and never books on a static automation', () => {
    expect(deliveryProblem(LEGACY_V1, 'booking', { dynamicEnabled: false })).toBeNull()
    expect(deliveryProblem(STUDIO_NEWSLETTER_V1, 'external_url', { dynamicEnabled: false })).toMatch(/CONTENT_EMAIL_DYNAMIC_ENABLED/)
    expect(deliveryProblem(STUDIO_NEWSLETTER_V1, 'external_url', { dynamicEnabled: true })).toBeNull()
    expect(deliveryProblem(STUDIO_STATIC_V1, 'none', { dynamicEnabled: false })).toBeNull()
    expect(deliveryProblem(STUDIO_STATIC_V1, 'booking', { dynamicEnabled: true })).toMatch(/does not support/)
  })

  it('lists the BookingUrl check only where it matters', () => {
    expect(templateChecklist(STUDIO_STATIC_V1, 'none').join(' ')).toMatch(/must not reference \{\{BookingUrl\}\}/)
    expect(templateChecklist(STUDIO_NEWSLETTER_V1, 'booking').join(' ')).not.toMatch(/BookingUrl/)
    expect(templateChecklist(LEGACY_V1, 'booking')).toEqual(['The template footer carries {{PrefsUrl}} (one preferences link).'])
  })

  it('strips reserved fields case-insensitively and drops non-strings', () => {
    expect(stripReservedFields({ Headline: 'a', bookingurl: 'x', PrefsUrl: 'y', Courses: 'yes', N: 3 })).toEqual({ Headline: 'a' })
    expect(stripReservedFields(null)).toEqual({})
  })
})

describe('url helpers', () => {
  it('derives the content-public prefix from the Supabase origin', () => {
    expect(contentPublicPrefix('https://proj.supabase.co/')).toBe(PREFIX)
    expect(contentPublicPrefix('')).toBeNull()
  })

  it('accepts a local stack image only under its own configured prefix', () => {
    const local = 'http://127.0.0.1:54321/storage/v1/object/public/content-public/p/'
    expect(imageProblem(`${local}a/b.png`, local)).toBeNull()
    expect(imageProblem(`${local}a/b.png`, PREFIX)).not.toBeNull()
  })

  it('rejects malformed links', () => {
    expect(linkProblem('not a url')).not.toBeNull()
    expect(linkProblem('notaurl')).toBe('is not a valid link.')
    expect(linkProblem('https://ai4l.com.au')).toBeNull()
  })
})

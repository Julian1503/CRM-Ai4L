import { adaptRevisionToEmail, cleanSocialText, clip, EMAIL_LIMITS } from './toEmailCampaign'
import type { RevisionContent } from './types'

function revision(overrides: Partial<RevisionContent> = {}): RevisionContent {
  return { body: '', hashtags: [], callToAction: null, linkUrl: null, fields: {}, assets: [], ...overrides }
}

describe('cleanSocialText', () => {
  it('removes hashtag blocks and social-only prompts but keeps the facts', () => {
    const text = 'Our workshop runs on 14 May in Brisbane. Link in bio!\n\nSeats are limited to 20. #training #rto'
    expect(cleanSocialText(text)).toBe('Our workshop runs on 14 May in Brisbane.\n\nSeats are limited to 20.')
  })

  it('keeps the word of an inline hashtag', () => {
    expect(cleanSocialText('New #compliance guide out now')).toBe('New compliance guide out now')
  })

  it.each(['Tap the link in our bio.', 'See link in comments.', 'Swipe up to read.', 'DM us for details.', 'Like, share and follow for more.'])(
    'drops "%s"',
    (phrase) => {
      expect(cleanSocialText(`Fact one. ${phrase}`)).toBe('Fact one.')
    }
  )
})

describe('clip', () => {
  it('keeps short text and cuts at a sentence or a word', () => {
    expect(clip('Short.', 10)).toBe('Short.')
    expect(clip('One sentence here. Another sentence follows on.', 30)).toBe('One sentence here.')
    expect(clip('averyveryverylongword another', 12)).toBe('averyveryve…')
    expect(clip('word word word word', 12)).toBe('word word…')
  })
})

describe('adaptRevisionToEmail', () => {
  it('derives subject, preheader and body from a social post', () => {
    const adapted = adaptRevisionToEmail(
      revision({
        body: 'New assessment rules start in July. Here is what changes.\n\nProviders must update their tools by June.\n\n#rto #compliance',
        callToAction: 'Read the guide',
        linkUrl: 'https://ai4l.com.au/guide',
        assets: [{ assetId: 'b', alt: 'B', order: 1 }, { assetId: 'a', alt: 'A', order: 0 }],
      }),
      { title: 'Assessment rules 2026' }
    )

    expect(adapted.subject).toBe('Assessment rules 2026')
    expect(adapted.fields.Headline).toBe('Assessment rules 2026')
    expect(adapted.fields.Intro).toBe('New assessment rules start in July. Here is what changes.')
    expect(adapted.fields.Body).toBe('Providers must update their tools by June.')
    expect(adapted.fields.Preheader).toBe('New assessment rules start in July.')
    expect(adapted.fields.CtaLabel).toBe('Read the guide')
    expect(adapted).toMatchObject({ ctaMode: 'external_url', ctaUrl: 'https://ai4l.com.au/guide' })
    expect(adapted.assets.map((asset) => asset.assetId)).toEqual(['a', 'b'])
    expect(adapted.notes.join(' ')).toMatch(/Hashtags/)
    expect(adapted.fields.Body).not.toContain('#')
  })

  it('splits a single paragraph into opening and body, and drops a non-https link', () => {
    const adapted = adaptRevisionToEmail(revision({ body: 'First fact here. Second fact follows.', linkUrl: 'http://insecure.example', callToAction: 'Go' }))

    expect(adapted.fields.Intro).toBe('First fact here.')
    expect(adapted.fields.Body).toBe('Second fact follows.')
    expect(adapted).toMatchObject({ ctaMode: 'none', ctaUrl: null })
    expect(adapted.fields.CtaLabel).toBe('')
    expect(adapted.notes.join(' ')).toMatch(/not an https link/)
    expect(adapted.subject).toBe('First fact here.')
  })

  it('uses an email variant\'s own fields as they are', () => {
    const adapted = adaptRevisionToEmail(
      revision({
        body: 'ignored',
        fields: { subject: 'Subj', preheader: 'Pre', headline: 'Head', intro: 'Intro', body: 'Body text', ctaLabel: 'Book' },
      })
    )

    expect(adapted.subject).toBe('Subj')
    expect(adapted.fields).toEqual({ Preheader: 'Pre', Headline: 'Head', Intro: 'Intro', Body: 'Body text', CtaLabel: '' })
    expect(adapted.notes).toEqual([])
  })

  it('respects every engine limit', () => {
    const long = `${'Word '.repeat(400)}.`
    const adapted = adaptRevisionToEmail(revision({ body: `${long}\n\n${long}`, callToAction: 'x'.repeat(60), linkUrl: 'https://a.io' }))

    expect(adapted.subject.length).toBeLessThanOrEqual(EMAIL_LIMITS.subject)
    expect(adapted.fields.Headline.length).toBeLessThanOrEqual(EMAIL_LIMITS.headline)
    expect(adapted.fields.Intro.length).toBeLessThanOrEqual(EMAIL_LIMITS.intro)
    expect(adapted.fields.Body.length).toBeLessThanOrEqual(EMAIL_LIMITS.body)
    expect(adapted.fields.Preheader.length).toBeLessThanOrEqual(EMAIL_LIMITS.preheader)
    expect(adapted.fields.CtaLabel.length).toBeLessThanOrEqual(EMAIL_LIMITS.ctaLabel)
  })
})

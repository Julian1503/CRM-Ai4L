import { CAMPAIGN_COPY_FIELDS } from './mergeFields'
import {
  DEFAULT_BRAND_VOICE,
  REDACTED,
  buildRetryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  redactPii,
  type CampaignBrief,
} from './prompt'

function brief(overrides: Partial<CampaignBrief> = {}): CampaignBrief {
  return {
    campaignName: 'Spring outreach',
    audience: {
      segmentName: 'Victorian RTOs',
      size: 412,
      state: 'VIC',
      status: 'prospect',
      ...overrides.audience,
    },
    ...overrides,
  }
}

describe('redactPii', () => {
  test('removes an email address', () => {
    expect(redactPii('chase up jane.doe+work@example.com.au today')).toBe(
      `chase up ${REDACTED} today`
    )
  })

  test('removes an Australian mobile number', () => {
    expect(redactPii('call 0412 345 678')).toBe(`call ${REDACTED}`)
  })

  test('removes an international-format number', () => {
    expect(redactPii('+61 412 345 678')).toBe(REDACTED)
  })

  test('leaves ordinary copy alone', () => {
    const text = 'RTOs in Victoria renewing their scope in 2026'

    expect(redactPii(text)).toBe(text)
  })

  test('does not eat a short number that carries meaning', () => {
    expect(redactPii('a 30 minute consultation')).toBe('a 30 minute consultation')
  })
})

describe('buildSystemPrompt', () => {
  test('names every slot the model must fill, with its limit', () => {
    const prompt = buildSystemPrompt()

    for (const field of CAMPAIGN_COPY_FIELDS) {
      expect(prompt).toContain(field.tag)
      expect(prompt).toContain(`max ${field.maxLength} characters`)
    }
  })

  test('states the booking action, which is the point of every campaign', () => {
    expect(buildSystemPrompt().toLowerCase()).toContain('consultation')
  })

  test('carries the Spam Act framing', () => {
    expect(buildSystemPrompt()).toContain('Spam Act 2003')
  })

  test('forbids inventing contact details', () => {
    expect(buildSystemPrompt()).toContain('must not invent any')
  })

  test('uses the default voice, and takes an override', () => {
    expect(buildSystemPrompt()).toContain(DEFAULT_BRAND_VOICE.trim())
    expect(buildSystemPrompt('Loud and punchy.')).toContain('Loud and punchy.')
    expect(buildSystemPrompt('Loud and punchy.')).not.toContain(
      DEFAULT_BRAND_VOICE.trim()
    )
  })

  test('is stable across calls, so it can be a cached prefix', () => {
    expect(buildSystemPrompt()).toBe(buildSystemPrompt())
  })
})

describe('buildUserPrompt', () => {
  test('carries the segment values that define the audience', () => {
    const prompt = buildUserPrompt(brief())

    expect(prompt).toContain('Spring outreach')
    expect(prompt).toContain('Victorian RTOs')
    expect(prompt).toContain('412 contacts')
    expect(prompt).toContain('VIC')
    expect(prompt).toContain('prospect')
  })

  test('omits filters the segment does not set', () => {
    const prompt = buildUserPrompt({
      campaignName: 'Everyone',
      audience: { segmentName: 'All subscribers', size: 5082 },
    })

    expect(prompt).not.toContain('Job type:')
    expect(prompt).not.toContain('Australian state:')
    expect(prompt).not.toContain('Matches the term:')
  })

  test('states that the audience is opted in', () => {
    expect(buildUserPrompt(brief())).toContain('subscribed to the newsletter')
  })

  test('redacts an email address hiding in a segment search term', () => {
    const prompt = buildUserPrompt(
      brief({
        audience: {
          segmentName: 'Follow-ups',
          size: 3,
          search: 'yvonnec@status.net.au',
        },
      })
    )

    expect(prompt).not.toContain('yvonnec@status.net.au')
    expect(prompt).toContain(REDACTED)
  })

  test('redacts PII in operator notes', () => {
    const prompt = buildUserPrompt(
      brief({ notes: 'Follow the thread with rob@client.com.au and 0412 345 678.' })
    )

    expect(prompt).not.toContain('rob@client.com.au')
    expect(prompt).not.toContain('0412 345 678')
  })

  test('redacts an email address used as the segment name', () => {
    const prompt = buildUserPrompt(
      brief({ audience: { segmentName: 'saved: rob@client.com.au', size: 1 } })
    )

    expect(prompt).not.toContain('rob@client.com.au')
  })

  test('includes operator notes when they carry no PII', () => {
    expect(buildUserPrompt(brief({ notes: 'Lead with the audit offer.' }))).toContain(
      'Lead with the audit offer.'
    )
  })

  test('asks for exactly one tool call', () => {
    expect(buildUserPrompt(brief())).toContain('exactly once')
  })
})

describe('buildRetryPrompt', () => {
  test('repeats each specific failure so the retry can fix it', () => {
    const prompt = buildRetryPrompt([
      'Headline is 94 characters; the template allows 80.',
      'CtaLabel is empty.',
    ])

    expect(prompt).toContain('Headline is 94 characters')
    expect(prompt).toContain('CtaLabel is empty.')
  })

  test('tells the model to cut words rather than truncate', () => {
    expect(buildRetryPrompt(['too long'])).toContain('not by truncating')
  })
})

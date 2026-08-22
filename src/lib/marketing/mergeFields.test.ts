import {
  BOOKING_URL_MERGE_FIELD,
  CAMPAIGN_COPY_FIELDS,
  RESERVED_MERGE_FIELDS,
  buildCopyToolSchema,
  findMissingMergeFields,
  validateCampaignCopy,
} from './mergeFields'

/** A complete, valid copy object, used as the base for negative cases. */
function validCopy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const field of CAMPAIGN_COPY_FIELDS) {
    copy[field.tag] = 'x'.repeat(Math.min(20, field.maxLength))
  }
  return { ...copy, ...overrides }
}

describe('CAMPAIGN_COPY_FIELDS', () => {
  test('every tag is unique', () => {
    const tags = CAMPAIGN_COPY_FIELDS.map((field) => field.tag)

    expect(new Set(tags).size).toBe(tags.length)
  })

  test('no copy field collides with a field written at send time', () => {
    const tags = CAMPAIGN_COPY_FIELDS.map((field) => field.tag)

    for (const reserved of RESERVED_MERGE_FIELDS) {
      expect(tags).not.toContain(reserved)
    }
  })

  test('the booking link is reserved', () => {
    expect(RESERVED_MERGE_FIELDS).toContain(BOOKING_URL_MERGE_FIELD)
  })
})

describe('buildCopyToolSchema', () => {
  test('requires every copy field and forbids extras', () => {
    const schema = buildCopyToolSchema()

    expect(schema.required.sort()).toEqual(
      CAMPAIGN_COPY_FIELDS.map((field) => field.tag).sort()
    )
    expect(schema.additionalProperties).toBe(false)
  })

  test('carries the length cap into the schema so the model sees the same limit', () => {
    const schema = buildCopyToolSchema()

    for (const field of CAMPAIGN_COPY_FIELDS) {
      expect(schema.properties[field.tag].maxLength).toBe(field.maxLength)
      expect(schema.properties[field.tag].description).toBe(field.description)
    }
  })

  test('does not offer a reserved field to the model', () => {
    const schema = buildCopyToolSchema()

    for (const reserved of RESERVED_MERGE_FIELDS) {
      expect(schema.properties[reserved]).toBeUndefined()
    }
  })
})

describe('validateCampaignCopy', () => {
  test('accepts a complete object and trims each value', () => {
    const result = validateCampaignCopy(validCopy({ Headline: '  Spaced out  ' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.Headline).toBe('Spaced out')
    expect(Object.keys(result.value).sort()).toEqual(
      CAMPAIGN_COPY_FIELDS.map((field) => field.tag).sort()
    )
  })

  test.each([null, undefined, 'a string', 42, ['array']])(
    'rejects %p, which is not an object',
    (input) => {
      const result = validateCampaignCopy(input)

      expect(result.ok).toBe(false)
    }
  )

  test('reports a missing field by name', () => {
    const copy = validCopy()
    delete copy.Headline

    const result = validateCampaignCopy(copy)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContain('Headline is missing.')
  })

  test('rejects a whitespace-only field rather than storing a blank', () => {
    const result = validateCampaignCopy(validCopy({ CtaLabel: '   ' }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContain('CtaLabel is empty.')
  })

  test('rejects a field that overruns the template', () => {
    const headline = CAMPAIGN_COPY_FIELDS.find((field) => field.tag === 'Headline')!
    const result = validateCampaignCopy(
      validCopy({ Headline: 'x'.repeat(headline.maxLength + 1) })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toMatch(/Headline is \d+ characters/)
  })

  test('measures length after trimming, so trailing space is not an overrun', () => {
    const headline = CAMPAIGN_COPY_FIELDS.find((field) => field.tag === 'Headline')!
    const result = validateCampaignCopy(
      validCopy({ Headline: `${'x'.repeat(headline.maxLength)}   ` })
    )

    expect(result.ok).toBe(true)
  })

  test('refuses generated copy that tries to set the booking link', () => {
    const result = validateCampaignCopy(
      validCopy({ [BOOKING_URL_MERGE_FIELD]: 'https://evil.example.com' })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContain(
      `${BOOKING_URL_MERGE_FIELD} is set at send time and cannot be generated.`
    )
  })

  test('rejects an unrecognised field instead of silently dropping it', () => {
    const result = validateCampaignCopy(validCopy({ Footer: 'anything' }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContain('Footer is not a field this template merges.')
  })

  test('collects every problem in one pass', () => {
    const copy = validCopy({ CtaLabel: '' })
    delete copy.Headline

    const result = validateCampaignCopy(copy)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(2)
  })
})

describe('findMissingMergeFields', () => {
  test('lists every required tag when the provider list is bare', () => {
    const missing = findMissingMergeFields(['EmailAddress', 'FirstName', 'LastName'])

    expect(missing).toEqual([
      ...CAMPAIGN_COPY_FIELDS.map((field) => field.tag),
      ...RESERVED_MERGE_FIELDS,
    ])
  })

  test('returns nothing when every tag is present', () => {
    const tags = [
      ...CAMPAIGN_COPY_FIELDS.map((field) => field.tag),
      ...RESERVED_MERGE_FIELDS,
      'FirstName',
    ]

    expect(findMissingMergeFields(tags)).toEqual([])
  })

  test('matches tags case-insensitively, as the provider does', () => {
    const tags = [
      ...CAMPAIGN_COPY_FIELDS.map((field) => field.tag.toUpperCase()),
      ...RESERVED_MERGE_FIELDS.map((tag) => tag.toLowerCase()),
    ]

    expect(findMissingMergeFields(tags)).toEqual([])
  })

  test('names the booking link when only the copy fields were created', () => {
    const missing = findMissingMergeFields(
      CAMPAIGN_COPY_FIELDS.map((field) => field.tag)
    )

    expect(missing).toEqual([BOOKING_URL_MERGE_FIELD])
  })
})

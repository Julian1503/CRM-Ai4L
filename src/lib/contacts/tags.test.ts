import {
  MAX_TAGS_PER_CONTACT,
  TAG_NAME_MAX_LENGTH,
  dedupeTagNames,
  describeTagError,
  formatTagList,
  isUuid,
  mergeTagNames,
  normalizeTagName,
  parseTagList,
  tagKey,
  validateTagName,
} from './tags'

describe('normalizeTagName / tagKey', () => {
  it('trims and collapses inner whitespace, keeping case for display', () => {
    expect(normalizeTagName('  Workshop \t 2026 ')).toBe('Workshop 2026')
  })

  it('compares names ignoring case and spacing', () => {
    expect(tagKey(' VIP  Gold')).toBe(tagKey('vip gold'))
  })
})

describe('parseTagList', () => {
  it('splits on the documented separator', () => {
    expect(parseTagList('VIP; Workshop 2026')).toEqual({ names: ['VIP', 'Workshop 2026'], errors: [] })
  })

  it('keeps commas inside a name', () => {
    expect(parseTagList('Sydney, NSW;VIP').names).toEqual(['Sydney, NSW', 'VIP'])
  })

  it('treats an empty or blank cell as "no tags", never as an error', () => {
    expect(parseTagList('')).toEqual({ names: [], errors: [] })
    expect(parseTagList('   ')).toEqual({ names: [], errors: [] })
    expect(parseTagList(null)).toEqual({ names: [], errors: [] })
    expect(parseTagList(undefined)).toEqual({ names: [], errors: [] })
  })

  it('drops empty entries such as a trailing separator', () => {
    expect(parseTagList('VIP;; ;').names).toEqual(['VIP'])
  })

  it('deduplicates case-insensitively, keeping the first spelling', () => {
    expect(parseTagList('VIP; vip ;Vip').names).toEqual(['VIP'])
  })

  it('rejects an over-long name instead of truncating it', () => {
    const result = parseTagList(`VIP; ${'x'.repeat(TAG_NAME_MAX_LENGTH + 1)}`)

    expect(result.names).toEqual(['VIP'])
    expect(result.errors).toEqual([expect.objectContaining({ kind: 'too_long', maxLength: TAG_NAME_MAX_LENGTH })])
  })

  it('accepts a name of exactly the maximum length', () => {
    expect(parseTagList('x'.repeat(TAG_NAME_MAX_LENGTH)).errors).toEqual([])
  })

  it('rejects more than the per-contact limit', () => {
    const cell = Array.from({ length: MAX_TAGS_PER_CONTACT + 1 }, (_, i) => `T${i}`).join(';')

    expect(parseTagList(cell).errors).toEqual([
      { kind: 'too_many', count: MAX_TAGS_PER_CONTACT + 1, max: MAX_TAGS_PER_CONTACT },
    ])
  })
})

describe('mergeTagNames', () => {
  it('combines row and common tags into one deduplicated list', () => {
    expect(mergeTagNames(['VIP', 'Expo'], ['vip', 'Newsletter']).names).toEqual(['VIP', 'Expo', 'Newsletter'])
  })

  it('applies the limit to the merged list', () => {
    const row = Array.from({ length: 30 }, (_, i) => `R${i}`)
    const common = Array.from({ length: 21 }, (_, i) => `C${i}`)

    expect(mergeTagNames(row, common).errors).toHaveLength(1)
  })
})

describe('helpers', () => {
  it('formats names for a Tags cell, the inverse of parseTagList', () => {
    const names = ['VIP', 'Workshop 2026']
    expect(parseTagList(formatTagList(names)).names).toEqual(names)
  })

  it('describes errors in plain language', () => {
    expect(describeTagError({ kind: 'too_many', count: 51, max: 50 })).toMatch(/at most 50/)
    expect(describeTagError(validateTagName('y'.repeat(81))!)).toMatch(/longer than 80/)
  })

  it('recognises UUIDs only', () => {
    expect(isUuid('aaaaaaaa-0000-4000-8000-000000000001')).toBe(true)
    expect(isUuid('vip')).toBe(false)
    expect(isUuid(42)).toBe(false)
  })

  it('leaves the error list empty for a valid list', () => {
    expect(dedupeTagNames(['A', 'B']).errors).toEqual([])
  })
})

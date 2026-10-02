/** @jest-environment node */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { composePostText, formatHashtag, PLATFORM_LIMITS } from './postText'
import { CONTENT_CHANNELS } from './types'

type Case = {
  name: string
  body: string
  call_to_action: string | null
  hashtags: string[]
  expected: string
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'shared', 'content-contracts', 'fixtures', 'post-text-cases.json'), 'utf8')
) as { cases: Case[] }

describe('composePostText (shared fixture)', () => {
  it('has cases to check (guards against a silently empty fixture)', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it.each(fixture.cases.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    expect(composePostText(testCase.body, testCase.call_to_action, testCase.hashtags)).toBe(testCase.expected)
  })
})

describe('formatHashtag', () => {
  it('adds the # the database strips, keeps an existing one, and drops blanks', () => {
    expect(formatHashtag(' AI4L ')).toBe('#AI4L')
    expect(formatHashtag('#AI4L')).toBe('#AI4L')
    expect(formatHashtag('   ')).toBe('')
  })

  it('composes stored (hashless) tags as posted hashtags', () => {
    expect(composePostText('Hi.', undefined, ['AI4L', 'Learn'])).toBe('Hi.\n\n#AI4L #Learn')
  })
})

describe('PLATFORM_LIMITS', () => {
  it('covers every channel with positive limits', () => {
    CONTENT_CHANNELS.forEach((channel) => {
      expect(PLATFORM_LIMITS[channel].maxChars).toBeGreaterThan(0)
      expect(PLATFORM_LIMITS[channel].maxImages).toBeGreaterThan(0)
    })
  })

  it('keeps the enforced Instagram limits', () => {
    expect(PLATFORM_LIMITS.instagram).toEqual({ maxChars: 2200, maxHashtags: 30, maxImages: 10, requiresImage: true })
    expect(PLATFORM_LIMITS.email.maxHashtags).toBe(0)
  })
})

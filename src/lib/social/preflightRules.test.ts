import cases from '../../../shared/content-contracts/fixtures/preflight-cases.json'

import type { SocialPlatform } from '@/lib/content-studio/types'

import { codePointLength, evaluateContentRules } from './preflightRules'

type Case = {
  name: string
  platform: SocialPlatform
  text: string
  hashtagCount: number
  images: { mimeType: string; width: number; height: number }[]
  blocking: string[]
  warnings: string[]
}

describe('evaluateContentRules (shared preflight contract)', () => {
  it.each((cases.cases as Case[]).map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const issues = evaluateContentRules(entry)

    expect(issues.filter((issue) => issue.blocking).map((issue) => issue.code)).toEqual(entry.blocking)
    expect(issues.filter((issue) => !issue.blocking).map((issue) => issue.code)).toEqual(entry.warnings)
  })

  it('numbers each image in a carousel so the operator knows which one to replace', () => {
    const issues = evaluateContentRules({
      platform: 'instagram',
      text: 'Hi',
      hashtagCount: 0,
      images: [
        { mimeType: 'image/jpeg', width: 1080, height: 1080 },
        { mimeType: 'image/png', width: 1080, height: 1080 },
      ],
    })

    expect(issues.find((issue) => issue.code === 'image_format')?.message).toMatch(/^Image 2: /)
  })

  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('\u{1F600}a')).toBe(2)
  })
})

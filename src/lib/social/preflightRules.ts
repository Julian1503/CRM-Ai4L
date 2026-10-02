import { PLATFORM_LIMITS } from '@/lib/content-studio/postText'
import type { PreflightIssue, SocialPlatform } from '@/lib/content-studio/types'

/**
 * The pure content rules of social preflight: what the network would certainly reject
 * (blocking) and what is worth a second look (warnings).
 *
 * Mirrors the engine's `content_issues` (services/content-engine/app/social/rules.py).
 * Both implementations run shared/content-contracts/fixtures/preflight-cases.json, so a
 * post the CRM lets through is one the worker will also accept. Lengths count Unicode
 * code points (as Python's len() does), not UTF-16 units.
 */

export type RuleImage = { mimeType: string; width: number; height: number }

export type ContentRuleInput = {
  platform: SocialPlatform
  text: string
  hashtagCount: number
  images: readonly RuleImage[]
}

export const INSTAGRAM_MIN_WIDTH = 320
export const INSTAGRAM_MIN_ASPECT = 0.8
export const INSTAGRAM_MAX_ASPECT = 1.91
/** Instagram serves at most 1440 px wide; wider images are downscaled before posting. */
const SOCIAL_MAX_WIDTH = 1440

/** Above these counts hashtags usually hurt reach (warning only). */
export const HASHTAG_WARN_ABOVE: Readonly<Record<SocialPlatform, number>> = {
  facebook: 10,
  instagram: 15,
  linkedin: 5,
}

const blocking = (code: string, message: string): PreflightIssue => ({ code, message, blocking: true })
const warning = (code: string, message: string): PreflightIssue => ({ code, message, blocking: false })

export function codePointLength(text: string): number {
  return Array.from(text).length
}

function instagramImageIssues(images: readonly RuleImage[]): PreflightIssue[] {
  const issues: PreflightIssue[] = []
  images.forEach((image, index) => {
    const prefix = images.length > 1 ? `Image ${index + 1}: ` : ''
    if (image.mimeType !== 'image/jpeg') {
      issues.push(blocking('image_format', `${prefix}Instagram only accepts JPEG (${image.mimeType} given).`))
    }
    if (Math.min(image.width, SOCIAL_MAX_WIDTH) < INSTAGRAM_MIN_WIDTH) {
      issues.push(blocking('image_too_small', `${prefix}The image is ${image.width}px wide; Instagram needs at least ${INSTAGRAM_MIN_WIDTH}px.`))
    }
    if (image.height > 0) {
      const aspect = image.width / image.height
      if (aspect < INSTAGRAM_MIN_ASPECT || aspect > INSTAGRAM_MAX_ASPECT) {
        issues.push(
          blocking(
            'image_aspect',
            `${prefix}The image is ${image.width}×${image.height} (ratio ${aspect.toFixed(2)}); Instagram accepts ${INSTAGRAM_MIN_ASPECT} to ${INSTAGRAM_MAX_ASPECT}.`
          )
        )
      }
    }
  })
  return issues
}

function blockingContentIssues({ platform, text, hashtagCount, images }: ContentRuleInput): PreflightIssue[] {
  const limits = PLATFORM_LIMITS[platform]
  const issues: PreflightIssue[] = []
  const length = codePointLength(text)

  if (text.trim() === '') issues.push(blocking('text_empty', 'The post is empty.'))
  else if (length > limits.maxChars) {
    issues.push(blocking('text_too_long', `The post is ${length} characters; ${platform} allows ${limits.maxChars}.`))
  }
  if (hashtagCount > limits.maxHashtags) {
    issues.push(blocking('too_many_hashtags', `${hashtagCount} hashtags; ${platform} allows ${limits.maxHashtags}.`))
  }
  if (limits.requiresImage && images.length === 0) {
    issues.push(blocking('image_required', `${platform[0].toUpperCase()}${platform.slice(1)} posts require an image.`))
  }
  if (images.length > limits.maxImages) {
    issues.push(blocking('too_many_images', `${images.length} images selected; ${platform} accepts ${limits.maxImages}.`))
  }
  if (platform === 'instagram') issues.push(...instagramImageIssues(images))
  return issues
}

function contentWarnings({ platform, hashtagCount, images }: ContentRuleInput, blockers: PreflightIssue[]): PreflightIssue[] {
  const warnings: PreflightIssue[] = []
  const tooManyTags = blockers.some((issue) => issue.code === 'too_many_hashtags')
  if (!tooManyTags && hashtagCount > HASHTAG_WARN_ABOVE[platform]) {
    warnings.push(warning('hashtags_many', `${hashtagCount} hashtags is more than usually performs well on ${platform}.`))
  }
  if (platform === 'instagram' && images.length >= 2) {
    warnings.push(warning('carousel_crop', 'Instagram crops every image in a carousel to the aspect ratio of the first one.'))
  }
  return warnings
}

/** Blocking issues first (engine order), then warnings. */
export function evaluateContentRules(input: ContentRuleInput): PreflightIssue[] {
  const blockers = blockingContentIssues(input)
  return [...blockers, ...contentWarnings(input, blockers)]
}

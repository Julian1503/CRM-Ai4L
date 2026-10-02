import type { ContentChannel, PlatformLimits } from './types'

/**
 * The single blob of text a post (or an export) carries, and the per-channel limits
 * preflight checks it against. Ported from WRCC `app/publishing/rules.py`
 * (`compose_post_text`, `LIMITS`); both implementations test against
 * shared/content-contracts/fixtures/post-text-cases.json so they cannot drift.
 *
 * The CRM builds the text a publish_social job posts (worker context), so the copied
 * export, the preview and the published post are the same string.
 */

/**
 * Facebook and LinkedIn publish no hashtag ceiling of their own, so 100 is ours; Instagram's
 * 30 is a real API limit and it has no text-only feed post. Email carries no hashtags; its
 * body limit is the revision body limit in the database.
 */
export const PLATFORM_LIMITS: Readonly<Record<ContentChannel, PlatformLimits>> = {
  facebook: { maxChars: 63_206, maxHashtags: 100, maxImages: 10, requiresImage: false },
  instagram: { maxChars: 2_200, maxHashtags: 30, maxImages: 10, requiresImage: true },
  linkedin: { maxChars: 3_000, maxHashtags: 100, maxImages: 20, requiresImage: false },
  email: { maxChars: 10_000, maxHashtags: 0, maxImages: 10, requiresImage: false },
}

/**
 * One hashtag as posted: trimmed, blank dropped (empty string), `#` added when the stored
 * tag has none — the database stores tags without their `#` (content_insert_revision).
 */
export function formatHashtag(tag: string): string {
  const trimmed = tag.trim()
  if (trimmed === '') return ''
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

/** Body, then call to action, then hashtags; blank sections are omitted. */
export function composePostText(
  body: string,
  callToAction: string | null | undefined,
  hashtags: readonly string[]
): string {
  const tags = hashtags.map(formatHashtag).filter((tag) => tag !== '').join(' ')
  const sections = [body.trim(), (callToAction ?? '').trim(), tags]

  return sections.filter((section) => section !== '').join('\n\n')
}

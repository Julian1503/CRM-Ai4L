import type { ConsentStream } from '@/lib/db/types'

/**
 * The consent stream named by a request, or the newsletter.
 *
 * Anything unrecognised falls back rather than throwing: the stream decides which
 * permission an audience is counted against, and the narrower of the two is the safe
 * answer to give a caller who did not say.
 */
export function readConsentStream(value: unknown): ConsentStream {
  return value === 'programs' ? 'programs' : 'newsletter'
}

/** The consent stream named by a request, or null when it names neither. */
export function parseConsentStream(value: unknown): ConsentStream | null {
  return value === 'newsletter' || value === 'programs' ? value : null
}

/** Human labels, shared by every picker and pill so the two never drift apart. */
export const CONSENT_STREAM_LABELS: Record<ConsentStream, string> = {
  newsletter: 'Newsletter',
  programs: 'Courses & training',
}

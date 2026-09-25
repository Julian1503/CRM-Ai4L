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

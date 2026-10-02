import type {
  ContentChannel,
  IngestStatus,
  JobStatus,
  PublicationStatus,
  ReviewState,
  SocialPlatform,
} from '@/lib/content-studio/types'
import { SOCIAL_PLATFORMS, TERMINAL_JOB_STATUSES } from '@/lib/content-studio/types'

export const CHANNEL_LABELS: Record<ContentChannel, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  email: 'Email',
}

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  uncertain: 'Needs a check',
}

export const PUBLICATION_STATUS_LABELS: Record<PublicationStatus, string> = {
  queued: 'Queued',
  dispatching: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  uncertain: 'Needs a check',
  cancelled: 'Cancelled',
}

export const REVIEW_LABELS: Record<ReviewState, string> = {
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
}

export const INGEST_LABELS: Record<IngestStatus, string> = {
  pending: 'Processing',
  ready: 'Ready',
  rejected: 'Rejected',
}

/** Visual tone of a status pill; each maps to one class in the stylesheet. */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const JOB_TONES: Record<JobStatus, Tone> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  uncertain: 'warning',
}

export const PUBLICATION_TONES: Record<PublicationStatus, Tone> = {
  queued: 'neutral',
  dispatching: 'info',
  published: 'success',
  failed: 'danger',
  uncertain: 'warning',
  cancelled: 'neutral',
}

export const REVIEW_TONES: Record<ReviewState, Tone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
}

export const INGEST_TONES: Record<IngestStatus, Tone> = {
  pending: 'info',
  ready: 'success',
  rejected: 'danger',
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status)
}

export function isSocialChannel(channel: ContentChannel): channel is SocialPlatform {
  return (SOCIAL_PLATFORMS as readonly string[]).includes(channel)
}

export function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** An https URL, or null. Anything else — http, javascript:, relative — is refused. */
export function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** "#one, two #three" → ['#one', '#two', '#three'] with duplicates dropped. */
export function parseHashtags(value: string): string[] {
  const tags = value
    .split(/[\s,]+/)
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter((tag) => tag.length > 0)
    .map((tag) => `#${tag}`)
  return Array.from(new Set(tags))
}

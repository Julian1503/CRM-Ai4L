import 'server-only'

import { sendTransactionalEmail } from '@/lib/email/resend'

/**
 * "A newsletter is waiting for your approval."
 *
 * Sent through Resend, like the booking confirmation, because it is an internal
 * notice to staff and not marketing: it goes to the addresses in
 * `CAMPAIGN_REVIEW_EMAILS`, never to contacts.
 *
 * Optional by design. Without configuration the scheduled campaign still lands in
 * review with its badge in the CRM; the email only saves someone from having to look.
 */

export type ReviewNotificationConfig = {
  apiKey: string
  from: string
  to: string[]
  /** The CRM's own origin, without a trailing slash. */
  appUrl: string
}

export type ReviewNotice = {
  scheduleName: string
  campaignId: string
  campaignName: string
  /** The generated headline, or null when generation failed. */
  subject: string | null
  /** The local date of the occurrence. */
  scheduledFor: string
  /** The queued topic this issue was written about; null when the queue was empty. */
  topicTitle: string | null
  /** Why the copy could not be written, when it could not. */
  generationError: string | null
}

export type ReviewNotificationResult =
  | { status: 'sent'; recipients: number }
  | { status: 'skipped'; reason: 'not_configured' }

/** Deliberately loose: this filters out typos in an env var, not hostile input. */
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function getReviewNotificationConfig(): ReviewNotificationConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from = process.env.NOTIFY_EMAIL_FROM?.trim() || process.env.BOOKING_EMAIL_FROM?.trim()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '')
  const to = (process.env.CAMPAIGN_REVIEW_EMAILS ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => ADDRESS_PATTERN.test(address))

  if (!apiKey || !from || !appUrl || to.length === 0) return null

  return { apiKey, from, to, appUrl }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderReviewEmail(
  notice: ReviewNotice,
  appUrl: string
): { subject: string; html: string; text: string } {
  const link = `${appUrl}/?view=campaigns&campaign=${encodeURIComponent(notice.campaignId)}`
  const failed = notice.generationError !== null

  const subject = failed
    ? `Newsletter needs attention: ${notice.scheduleName} (${notice.scheduledFor})`
    : `Newsletter ready for approval: ${notice.scheduleName} (${notice.scheduledFor})`

  const lines = failed
    ? [
        `The scheduled newsletter "${notice.campaignName}" was drafted, but its copy could not be written:`,
        '',
        notice.generationError as string,
        '',
        'Open it in the CRM to write the copy, then send it for review.',
      ]
    : [
        `The scheduled newsletter "${notice.campaignName}" is written and waiting for review.`,
        '',
        `Headline: ${notice.subject ?? '(none)'}`,
        notice.topicTitle
          ? `Topic: ${notice.topicTitle}`
          : 'No topic was queued, so the copy was written from the schedule’s goal alone.',
      ]

  const footer = 'Nothing is sent until someone approves it and presses Send in the CRM.'

  const text = [...lines, '', `Review it: ${link}`, '', footer].join('\n')

  const html = [
    ...lines.map((line) => (line === '' ? '' : `<p>${escapeHtml(line)}</p>`)),
    `<p><a href="${escapeHtml(link)}">Review it in the CRM</a></p>`,
    `<p style="color:#6d7b84;font-size:12px">${escapeHtml(footer)}</p>`,
  ]
    .filter(Boolean)
    .join('\n')

  return { subject, html, text }
}

/**
 * Emails every reviewer. One message each rather than one with several recipients, so
 * reviewers do not see each other's addresses and a bad address fails alone.
 *
 * The idempotency key is per campaign and recipient: a retried cron run for the same
 * occurrence does not email anyone twice.
 */
export async function sendReviewNotification(
  notice: ReviewNotice
): Promise<ReviewNotificationResult> {
  const config = getReviewNotificationConfig()

  if (!config) return { status: 'skipped', reason: 'not_configured' }

  const content = renderReviewEmail(notice, config.appUrl)

  for (const recipient of config.to) {
    await sendTransactionalEmail(
      { apiKey: config.apiKey, from: config.from },
      {
        to: recipient,
        ...content,
        idempotencyKey: `newsletter-review-${notice.campaignId}-${recipient}`,
      }
    )
  }

  return { status: 'sent', recipients: config.to.length }
}

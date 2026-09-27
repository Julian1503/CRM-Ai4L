/**
 * The "you are confirmed — now choose a time" email sent once checkout completes.
 *
 * Pure: builds the link and the message, sends nothing. Delivery lives in
 * `paidEmail.ts`.
 *
 * The scheduling link needs the raw booking token, which the database never stores
 * (only its hash). The one place it survives server-side is the Checkout session's
 * `success_url`, which Stripe returns on the session object — so the token is recovered
 * from there rather than persisted anywhere new.
 */

const SCHEDULED_PATH = /^\/book\/([A-Za-z0-9_-]+)\/scheduled\/?$/

export type SchedulingLink = { token: string; url: string }

/**
 * Rebuilds the post-checkout scheduling URL from a session's `success_url`.
 *
 * `origin` wins over the success URL's own host when given, so a link emailed now uses
 * the host the app is served from today. Returns null for anything that is not one of
 * our scheduling URLs: a session created elsewhere must not produce an email.
 */
export function buildSchedulingLink(
  successUrl: string | null | undefined,
  sessionId: string,
  origin?: string | null
): SchedulingLink | null {
  if (!successUrl || !sessionId) return null

  let parsed: URL

  try {
    parsed = new URL(successUrl)
  } catch {
    return null
  }

  const match = SCHEDULED_PATH.exec(parsed.pathname)
  if (!match) return null

  const token = match[1]
  let base = parsed.origin

  if (origin?.trim()) {
    try {
      base = new URL(origin.trim()).origin
    } catch {
      // A malformed configured origin falls back to the one the checkout was built with.
    }
  }

  const url = new URL(`/book/${token}/scheduled`, base)
  url.searchParams.set('session', sessionId)

  return { token, url: url.toString() }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export type ConfirmationEmailContent = { subject: string; html: string; text: string }

export function renderConfirmationEmail(params: {
  firstName: string | null | undefined
  schedulingUrl: string
}): ConfirmationEmailContent {
  const firstName = params.firstName?.trim() ?? ''
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,'
  const htmlGreeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,'
  const href = escapeHtml(params.schedulingUrl)

  const subject = 'Your consultation is confirmed — choose a time'

  const text = [
    greeting,
    '',
    'Your free consultation is confirmed and nothing was charged ($0).',
    '',
    'There is one step left: choose a 30-minute slot that suits you.',
    params.schedulingUrl,
    '',
    'If you already picked a time, you can ignore this email — your calendar invitation is on its way.',
    '',
    'Ai4L',
  ].join('\n')

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f5f2;font-family:Helvetica,Arial,sans-serif;color:#1c1b19;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr><td>
        <p style="margin:0 0 24px;font-size:18px;font-weight:700;">Ai4L.</p>
        <p style="margin:0 0 16px;font-size:16px;">${htmlGreeting}</p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">Your free consultation is confirmed and nothing was charged ($0).</p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.5;">There is one step left: choose a 30-minute slot that suits you.</p>
        <p style="margin:0 0 24px;">
          <a href="${href}" style="display:inline-block;background:#1c1b19;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">Choose a time</a>
        </p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b6862;line-height:1.5;">If the button does not work, copy this link into your browser:<br><a href="${href}" style="color:#6b6862;word-break:break-all;">${href}</a></p>
        <p style="margin:16px 0 0;font-size:13px;color:#6b6862;line-height:1.5;">If you already picked a time, you can ignore this email — your calendar invitation is on its way.</p>
      </td></tr>
    </table>
  </body>
</html>`

  return { subject, html, text }
}

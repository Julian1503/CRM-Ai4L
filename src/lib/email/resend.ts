import 'server-only'

/**
 * Transactional email through Resend.
 *
 * Separate from EmailOctopus on purpose: EmailOctopus is the marketing channel and only
 * sends to subscribed list members through pre-authored automations. A receipt-style
 * message ("you are confirmed, here is your link") has to reach the person who just
 * completed checkout regardless of their marketing preferences, and its body lives here
 * in code rather than in a provider template.
 *
 * Called over REST rather than through the SDK: one endpoint, one POST.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/** Long enough for a slow API, short enough not to hold a webhook open. */
const REQUEST_TIMEOUT_MS = 10_000

export type ResendConfig = {
  apiKey: string
  /** A sender on a domain verified in Resend, e.g. `Ai4L <bookings@example.com>`. */
  from: string
}

export type TransactionalEmail = {
  to: string
  subject: string
  html: string
  text: string
  /** Resend drops a repeat with the same key for 24h, so a replay sends nothing. */
  idempotencyKey: string
}

export function getResendConfig(): ResendConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from = process.env.BOOKING_EMAIL_FROM?.trim()

  if (!apiKey || !from) {
    return null
  }

  return { apiKey, from }
}

export async function sendTransactionalEmail(
  config: ResendConfig,
  email: TransactionalEmail,
  fetchImpl: typeof fetch = fetch
): Promise<{ id: string | null }> {
  const response = await fetchImpl(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': email.idempotencyKey,
    },
    body: JSON.stringify({
      from: config.from,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    // Resend's error body names the problem (unverified domain, invalid sender) and
    // never echoes the key, so it is safe and useful in a server log.
    const detail = await response.text().catch(() => '')
    throw new Error(`Resend rejected the email (${response.status}): ${detail.slice(0, 300)}`)
  }

  const body = (await response.json().catch(() => null)) as { id?: unknown } | null

  return { id: typeof body?.id === 'string' ? body.id : null }
}

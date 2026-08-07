/**
 * EmailOctopus API client (v2).
 *
 * Migrated from v1.6, which passed the API key in the JSON body and is legacy — its
 * retirement would break the only working integration in the product.
 *
 * ---------------------------------------------------------------------------
 * NOTE: verified against the documented v2 shape, not against a live account — no API
 * key was available. Confirm the endpoint, the `status` vocabulary and the error body
 * before go-live; all three are isolated in this file.
 * ---------------------------------------------------------------------------
 */

const API_BASE = 'https://api.emailoctopus.com'

/** v2 uses lowercase status values; v1.6 used uppercase. */
const STATUS_MAP = {
  SUBSCRIBED: 'subscribed',
  UNSUBSCRIBED: 'unsubscribed',
} as const

export type SubscriptionStatus = keyof typeof STATUS_MAP

export type SyncOptions = {
  /** Attempts made on a rate-limited request, including the first. */
  maxAttempts?: number
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_MAX_ATTEMPTS = 3
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Parses Retry-After (seconds), falling back to exponential backoff. */
export function getRetryDelayMs(retryAfterHeader: string | null, attempt: number): number {
  const seconds = Number.parseInt(retryAfterHeader ?? '', 10)

  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000
  }

  // 500ms, 1s, 2s…
  return 500 * 2 ** (attempt - 1)
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json()

    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>
      const detail = record.detail ?? record.message
      if (typeof detail === 'string') return detail

      const error = record.error
      if (error && typeof error === 'object') {
        const message = (error as Record<string, unknown>).message
        if (typeof message === 'string') return message
      }
    }
  } catch {
    // Non-JSON body — fall through to the status line.
  }

  return `HTTP Error ${response.status}`
}

/**
 * Creates or updates a contact on an EmailOctopus list.
 *
 * Retries only on 429 and 5xx. A 4xx is a request problem — retrying it just burns
 * quota and delays the real error.
 */
export async function syncContactToEmailOctopus(
  apiKey: string,
  listId: string,
  email: string,
  firstName: string,
  lastName: string,
  status: SubscriptionStatus,
  options: SyncOptions = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const sleep = options.sleep ?? defaultSleep

  const url = `${API_BASE}/lists/${encodeURIComponent(listId)}/contacts`

  const body = JSON.stringify({
    email_address: email,
    fields: {
      FirstName: firstName,
      LastName: lastName,
    },
    status: STATUS_MAP[status],
  })

  let lastError = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        // v2 authenticates by bearer token. v1.6 put the key in the body, which
        // leaked it into request logs.
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    })

    if (response.ok) {
      return
    }

    const isRetryable = response.status === 429 || response.status >= 500
    lastError = await readErrorMessage(response)

    if (!isRetryable || attempt === maxAttempts) {
      throw new Error(`EmailOctopus API Error: ${lastError}`)
    }

    await sleep(getRetryDelayMs(response.headers.get('retry-after'), attempt))
  }

  throw new Error(`EmailOctopus API Error: ${lastError}`)
}

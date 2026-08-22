import { EMAILOCTOPUS_LIMIT } from '../rateLimiter'

import type {
  CampaignProvider,
  PersonalisationFields,
  ProviderCapabilities,
  SendOutcome,
  TriggerSendParams,
} from './types'

/**
 * EmailOctopus provider.
 *
 * Verified constraints (2026-08-08), all of which shaped this adapter:
 *
 * - Campaign endpoints are READ-ONLY in v1 and v2. `GET /campaigns`,
 *   `GET /campaigns/{id}`, `/reports*`. No POST/PUT/DELETE under `/campaigns`.
 * - The only programmatic send trigger is `POST /automations/{id}/queue`, which starts
 *   an automation for ONE contact. The automation must use the "Started via API"
 *   trigger, and a contact can trigger it only once unless "Allow contacts to repeat"
 *   is enabled — which shifts deduplication onto us.
 * - The template lives in the EmailOctopus UI. Content reaches the email only through
 *   contact custom fields merged into that template.
 * - Reporting is keyed to campaign ids; there appear to be no automation reporting
 *   endpoints, so per-send opens and clicks likely never surface. Recorded as
 *   `perSendReporting: 'unknown'` rather than guessed either way.
 *
 * NOTE: the exact request body for the queue endpoint has not been exercised against a
 * live account. It is confined to `triggerSend` below.
 */

const API_BASE = 'https://api.emailoctopus.com'

export const EMAILOCTOPUS_CAPABILITIES: ProviderCapabilities = {
  canCreateCampaign: false,
  canSendBroadcast: false,
  canSupplyBody: false,
  requiresPreAuthoredTemplate: true,
  sendGranularity: 'per-contact',
  perSendReporting: 'unknown',
  rateLimit: EMAILOCTOPUS_LIMIT,
  repeatSendRequiresProviderSetting: true,
}

type Fetcher = typeof fetch

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json()

    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>
      const detail = record.detail ?? record.message

      if (typeof detail === 'string') return detail
    }
  } catch {
    // Non-JSON body.
  }

  return `HTTP ${response.status}`
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number.parseInt(response.headers.get('retry-after') ?? '', 10)

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

async function toOutcome(response: Response, reference: string | null): Promise<SendOutcome> {
  if (response.ok) {
    return { ok: true, reference }
  }

  return {
    ok: false,
    error: await readError(response),
    // 429 and 5xx are worth retrying; a 4xx is a request problem.
    retryable: response.status === 429 || response.status >= 500,
    retryAfterMs: retryAfterMs(response),
  }
}

export function createEmailOctopusProvider(config: {
  apiKey: string
  listId: string
  fetchImpl?: Fetcher
}): CampaignProvider {
  const doFetch = config.fetchImpl ?? fetch

  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }

  return {
    name: 'emailoctopus',
    capabilities: EMAILOCTOPUS_CAPABILITIES,

    async setContactFields(
      email: string,
      fields: PersonalisationFields
    ): Promise<SendOutcome> {
      // Contact upsert. This is the only way generated copy reaches the message,
      // since the body itself is owned by the provider-side template.
      const response = await doFetch(
        `${API_BASE}/lists/${encodeURIComponent(config.listId)}/contacts`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ email_address: email, fields }),
        }
      )

      return toOutcome(response, null)
    },

    async triggerSend({ campaignHandle, email }: TriggerSendParams): Promise<SendOutcome> {
      if (!campaignHandle) {
        return {
          ok: false,
          error:
            'No automation id configured. EmailOctopus cannot create a campaign via API; ' +
            'author an automation with the "Started via API" trigger and record its id.',
          retryable: false,
        }
      }

      const response = await doFetch(
        `${API_BASE}/automations/${encodeURIComponent(campaignHandle)}/queue`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ email_address: email }),
        }
      )

      let reference: string | null = null
      try {
        const body = await response.clone().json()
        if (body && typeof body === 'object') {
          const id = (body as Record<string, unknown>).id
          if (typeof id === 'string') reference = id
        }
      } catch {
        // No/!JSON body — the send may still have succeeded.
      }

      return toOutcome(response, reference)
    },
  }
}

/**
 * The merge tags the list actually carries.
 *
 * Separate from `CampaignProvider` because it is a setup diagnostic rather than part of
 * sending — but it guards the failure mode that motivated the whole merge-field
 * contract: a tag the template references and the list does not have merges to the
 * field's fallback, so the campaign sends with a hole in it and nothing errors.
 *
 * Verified against the live v2 API on 2026-08-20. Two details worth keeping:
 * - the list object exposes `fields[]`, each with `tag`, `label`, `type`, `fallback`;
 * - creating a field with `fallback: ""` is rejected 422 ("should not be blank"),
 *   while omitting the key entirely is accepted and stores null.
 */
export async function listMergeTags(config: {
  apiKey: string
  listId: string
  fetchImpl?: Fetcher
}): Promise<{ ok: true; tags: string[] } | { ok: false; error: string }> {
  const doFetch = config.fetchImpl ?? fetch

  const response = await doFetch(
    `${API_BASE}/lists/${encodeURIComponent(config.listId)}`,
    { headers: { Authorization: `Bearer ${config.apiKey}` } }
  )

  if (!response.ok) {
    return { ok: false, error: await readError(response) }
  }

  try {
    const body = (await response.json()) as { fields?: { tag?: unknown }[] }
    const tags = (body.fields ?? [])
      .map((field) => field.tag)
      .filter((tag): tag is string => typeof tag === 'string')

    return { ok: true, tags }
  } catch {
    return { ok: false, error: 'EmailOctopus returned an unreadable list payload.' }
  }
}

/**
 * Creates one merge field on the list.
 *
 * `fallback` is deliberately never sent. EmailOctopus rejects an empty string with a
 * 422 ("This value should not be blank"), while omitting the key stores null — and null
 * is what we want: a fallback would paper over a personalisation failure with plausible
 * text, which is exactly the silent-hole failure this whole contract exists to prevent.
 */
export async function createMergeField(config: {
  apiKey: string
  listId: string
  tag: string
  label: string
  fetchImpl?: Fetcher
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const doFetch = config.fetchImpl ?? fetch

  const response = await doFetch(
    `${API_BASE}/lists/${encodeURIComponent(config.listId)}/fields`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tag: config.tag, label: config.label, type: 'text' }),
    }
  )

  return response.ok ? { ok: true } : { ok: false, error: await readError(response) }
}

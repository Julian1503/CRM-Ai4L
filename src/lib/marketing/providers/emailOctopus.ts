import { createHash, randomUUID } from 'node:crypto'

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
 * - The queue endpoint identifies the recipient by `contact_id`, never by email address.
 *   v2 accepts either the contact's id or "an MD5 hash of the lowercase version of the
 *   contact's email address", which is what `emailOctopusContactId` computes. Posting
 *   `email_address` instead is rejected 422 for every recipient, which is how this
 *   adapter shipped: each send failed non-retryably and the campaign ended `failed`
 *   with the reason buried in the ledger.
 * - Errors follow RFC 7807: `detail` carries the message, and a 422 adds an `errors[]`
 *   array whose entries name the offending field. Both are read below, because
 *   "HTTP 422" alone tells an operator nothing they can act on.
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

/**
 * The contact identifier the API expects.
 *
 * Documented as "the ID of the contact, or an MD5 hash of the lowercase version of the
 * contact's email address". The hash is used rather than the id returned by the contact
 * upsert because it needs no round trip and stays correct for a contact this app has
 * never written.
 */
export function emailOctopusContactId(email: string): string {
  return createHash('md5').update(email.trim().toLowerCase(), 'utf8').digest('hex')
}

/** Field-level complaints from a 422, e.g. `contact_id: This value is not valid.` */
function readValidationDetails(record: Record<string, unknown>): string[] {
  if (!Array.isArray(record.errors)) return []

  return record.errors
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null

      const { pointer, detail } = entry as Record<string, unknown>

      if (typeof detail !== 'string') return null

      // The pointer is a JSON pointer such as `/contact_id`; the leading slash is
      // noise to an operator reading this in a banner.
      return typeof pointer === 'string' && pointer.trim() !== ''
        ? `${pointer.replace(/^\//, '')}: ${detail}`
        : detail
    })
    .filter((entry): entry is string => entry !== null)
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json()

    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>
      const detail = record.detail ?? record.message
      const validation = readValidationDetails(record)

      if (typeof detail === 'string') {
        return validation.length > 0 ? `${detail} (${validation.join('; ')})` : detail
      }

      if (validation.length > 0) return validation.join('; ')
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

      const contactId = emailOctopusContactId(email)

      const response = await doFetch(
        `${API_BASE}/automations/${encodeURIComponent(campaignHandle)}/queue`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ contact_id: contactId }),
        }
      )

      // The queue endpoint answers with an empty body, so the contact id is the only
      // handle on the queued send. Recorded so a ledger row can be traced back to a
      // contact in EmailOctopus.
      let reference: string | null = contactId
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

/**
 * The result of checking whether an automation id is one EmailOctopus recognises.
 *
 * `unknown` is deliberately distinct from `invalid`: a rate-limited or unreadable
 * answer must never render as "this automation does not exist", because an operator
 * would then go and change a setting that was correct.
 */
export type AutomationCheck =
  | { status: 'valid' }
  | { status: 'invalid'; error: string }
  | { status: 'unauthorised'; error: string }
  | { status: 'unknown'; error: string }

/**
 * The address used to probe an automation without sending anything.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a real subscriber, and the random
 * component makes a collision with a contact someone typed by hand impossible in
 * practice. Both matter: the probe below is a real `queue` request, and if the address
 * resolved to a contact on the list, checking an id would *send that contact an email*.
 */
export function automationProbeEmail(): string {
  return `crm-automation-probe-${randomUUID()}@invalid.invalid`
}

/**
 * Whether EmailOctopus recognises an automation id.
 *
 * There is no read endpoint for automations — verified against the live API on
 * 2026-08-31: `GET /automations`, `GET /automations?limit=n` and
 * `GET /lists/{id}/automations` all answer 404, and the v2 documentation lists
 * `POST /automations/{id}/queue` as the only automation endpoint. So an id pasted into
 * the CRM could not be checked at all, and a wrong one first surfaced as every
 * recipient failing mid-send.
 *
 * The check exploits the fact that `queue` resolves the automation *before* the
 * contact, and says which one it could not find:
 *
 *     unknown automation + any contact   -> 404 "Journey not found."
 *     known automation   + no contact    -> 404 "Contact not found."
 *
 * Both observed live against real ids on 2026-08-31. Queueing a contact that cannot
 * exist therefore identifies the automation without queueing a send — see
 * `automationProbeEmail` for why the address is safe.
 */
export async function verifyAutomation(config: {
  apiKey: string
  automationId: string
  fetchImpl?: Fetcher
  /** Injectable for tests. Must be an address that can never be on the list. */
  probeEmail?: string
}): Promise<AutomationCheck> {
  const automationId = config.automationId.trim()

  if (automationId === '') {
    return { status: 'invalid', error: 'No automation id.' }
  }

  const doFetch = config.fetchImpl ?? fetch
  const probe = config.probeEmail ?? automationProbeEmail()

  let response: Response

  try {
    response = await doFetch(
      `${API_BASE}/automations/${encodeURIComponent(automationId)}/queue`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contact_id: emailOctopusContactId(probe) }),
      }
    )
  } catch (error) {
    return {
      status: 'unknown',
      error: error instanceof Error ? error.message : 'EmailOctopus could not be reached.',
    }
  }

  // Should not happen: the probe contact cannot exist, so `queue` has nothing to start.
  // Treated as valid rather than as an error because a 2xx means the automation was
  // certainly found.
  if (response.ok) {
    return { status: 'valid' }
  }

  const detail = await readError(response)

  if (response.status === 401 || response.status === 403) {
    return { status: 'unauthorised', error: detail }
  }

  if (response.status === 404) {
    // EmailOctopus calls an automation a "journey" internally; this is the wording the
    // live API returns, not a guess.
    if (/journey/i.test(detail)) {
      return { status: 'invalid', error: detail }
    }

    if (/contact/i.test(detail)) {
      return { status: 'valid' }
    }
  }

  return { status: 'unknown', error: detail }
}

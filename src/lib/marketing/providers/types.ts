/**
 * Campaign provider adapter boundary.
 *
 * Exists because the send step is the *only* part of the marketing agent that is
 * provider-specific, and because EmailOctopus turns out to be unusually constrained:
 * campaigns are read-only over its API, so "send a campaign" has to be expressed as a
 * per-contact automation trigger.
 *
 * Segments, approval and the send ledger are all written against this interface, so
 * moving to a provider that supports programmatic create-plus-send (Mailchimp, Brevo,
 * Resend Broadcasts) is a new implementation of this file, not a rewrite.
 */

/**
 * What a provider can actually do.
 *
 * Declared as data rather than documented in prose so the UI can adapt — there is no
 * point rendering a body editor for a provider that cannot accept a body.
 */
export type ProviderCapabilities = {
  /** Can a campaign be created through the API at all? */
  canCreateCampaign: boolean
  /** Can one call send to a whole audience? */
  canSendBroadcast: boolean
  /** Can the message body be supplied through the API? */
  canSupplyBody: boolean
  /** Must the template be authored in the provider's own UI first? */
  requiresPreAuthoredTemplate: boolean
  /** How a send is addressed. */
  sendGranularity: 'broadcast' | 'per-contact'
  /** Whether per-send opens and clicks come back through the API. */
  perSendReporting: 'documented' | 'unknown' | 'none'
  /** Token-bucket shape, used to pace the fan-out and estimate duration. */
  rateLimit: { capacity: number; refillPerSecond: number }
  /**
   * True when re-sending to the same contact depends on a setting in the provider's
   * UI — which makes deduplication the caller's responsibility.
   */
  repeatSendRequiresProviderSetting: boolean
}

export type SendOutcome =
  | { ok: true; reference: string | null }
  | {
      ok: false
      error: string
      /** False for a request error; retrying it just burns quota. */
      retryable: boolean
      /** Provider-requested backoff, from Retry-After. */
      retryAfterMs?: number
    }

export type PersonalisationFields = Record<string, string>

export type TriggerSendParams = {
  /** Provider-side campaign handle. For EmailOctopus, the automation id. */
  campaignHandle: string
  email: string
  firstName: string
  lastName: string
}

export interface CampaignProvider {
  readonly name: string
  readonly capabilities: ProviderCapabilities

  /**
   * Writes personalisation tokens onto the contact.
   *
   * For providers that cannot accept a body, this is the only route content takes
   * into the email — the template merges these fields.
   */
  setContactFields(
    email: string,
    fields: PersonalisationFields
  ): Promise<SendOutcome>

  /** Starts the send for a single recipient. */
  triggerSend(params: TriggerSendParams): Promise<SendOutcome>
}

import type { SupabaseClient } from '@supabase/supabase-js'

import { createBooking } from '@/lib/booking/repository'
import type { CampaignRow, ClaimedCampaignSend, Database } from '@/lib/db/types'

import { BOOKING_URL_MERGE_FIELD } from './mergeFields'
import type { CampaignProvider } from './providers/types'
import { TokenBucket } from './rateLimiter'
import { stripReservedFields, type CtaMode } from './templateContracts'

/**
 * Campaign send fan-out (audit H3, H4).
 *
 * EmailOctopus has no broadcast send — the only trigger is
 * `POST /automations/{id}/queue`, addressed to one contact. So a "send" is a loop over
 * the run's recipient ledger, paced against a token bucket.
 *
 * Every recipient goes through four database-guarded steps:
 *
 *   1. claim_campaign_sends     atomic claim under a lease (FOR UPDATE SKIP LOCKED), so
 *                               two workers can never hold the same recipient
 *   2. begin_campaign_dispatch  immediately before the provider call: still the owner,
 *                               campaign still sending the approved revision, contact
 *                               still eligible (consent, lifecycle). Records that the
 *                               provider is about to be contacted.
 *   3. provider.triggerSend
 *   4. complete_campaign_send   only the owner can record the outcome
 *
 * If the process dies between 2 and 4, lease recovery marks the row `uncertain` — never
 * pending (which would resend) and never sent (which would be a guess). Provider timeouts
 * and 5xx on the queue call are `uncertain` too. Uncertain rows wait for a person.
 *
 * This cannot promise exactly-once delivery: EmailOctopus has no idempotency key. It
 * promises that nothing is re-sent automatically when the first attempt may have worked,
 * and that the ledger never claims more than is known.
 */

export class LedgerWriteError extends Error {
  constructor(step: string, message: string) {
    super(`Could not record ${step} in the send ledger: ${message}`)
    this.name = 'LedgerWriteError'
  }
}

export type SendProgress = {
  /** Recipients this invocation claimed. */
  total: number
  sent: number
  failed: number
  /** Skipped at dispatch because the contact was no longer eligible. */
  skipped: number
  /** Provider outcome unknown; left for reconciliation. */
  uncertain: number
  /** Known not to have been accepted (rate limit): back in the queue. */
  remaining: number
  /** Claims another worker or lease recovery took over. Nothing was sent for them. */
  lost: number
  /** The first provider refusal, verbatim — the one that started a systematic failure. */
  failureReason?: string
  /** Why work was deferred — a rate limit, not a bad request. */
  deferredReason?: string
}

type DispatchCampaign = Pick<CampaignRow, 'id' | 'provider_automation_id' | 'merge_fields' | 'send_run'>

/**
 * What goes to each recipient's contact fields, and whether the email books.
 *
 * Resolved by the caller (`resolveSendContent`): a Studio campaign's approved snapshot,
 * or a hand-written campaign's merge fields with a booking CTA. Omitted, the campaign's
 * own merge fields are sent in booking mode — the behaviour before contracts existed.
 */
export type SendContent = { fields: Record<string, string>; ctaMode: CtaMode }

type Outcome = 'sent' | 'failed' | 'pending' | 'uncertain'

async function complete(
  db: SupabaseClient<Database>,
  row: ClaimedCampaignSend,
  status: Outcome,
  details: { reference?: string | null; error?: string | null } = {}
): Promise<boolean> {
  const { data, error } = await db.rpc('complete_campaign_send', {
    p_send_id: row.send_id,
    p_token: row.claim_token,
    p_status: status,
    p_reference: details.reference ?? null,
    p_error: details.error ?? null,
  })

  // Checked, not assumed: an unrecorded success must surface as an error so the row is
  // left to lease recovery (which marks it uncertain), never quietly reported as done.
  if (error) throw new LedgerWriteError(`a ${status} outcome`, error.message)

  return data === true
}

async function beginDispatch(
  db: SupabaseClient<Database>,
  row: ClaimedCampaignSend
): Promise<'go' | 'lost' | 'skipped'> {
  const { data, error } = await db.rpc('begin_campaign_dispatch', {
    p_send_id: row.send_id,
    p_token: row.claim_token,
  })

  if (error) throw new LedgerWriteError('the dispatch start', error.message)

  return data === 'go' || data === 'skipped' ? data : 'lost'
}

export async function claimCampaignSends(
  db: SupabaseClient<Database>,
  campaign: Pick<CampaignRow, 'id' | 'send_run'>,
  limit: number,
  leaseSeconds = 300
): Promise<ClaimedCampaignSend[]> {
  const { data, error } = await db.rpc('claim_campaign_sends', {
    p_campaign_id: campaign.id,
    p_run: campaign.send_run ?? 1,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  })

  if (error) throw new LedgerWriteError('a claim', error.message)

  return (data ?? []) as ClaimedCampaignSend[]
}

/**
 * Claims and dispatches up to `maxToProcess` recipients of a sending campaign.
 *
 * Throws `LedgerWriteError` the moment a ledger write fails, abandoning the rest of the
 * chunk: continuing to email people whose outcomes cannot be recorded is exactly the
 * duplicate-send failure this exists to prevent.
 */
export async function executeCampaignSends(
  db: SupabaseClient<Database>,
  provider: CampaignProvider,
  campaign: DispatchCampaign,
  options: {
    maxToProcess?: number
    bucket?: TokenBucket
    /** Origin for booking links. In booking mode, when set, each recipient gets a single-use link. */
    baseUrl?: string
    leaseSeconds?: number
    content?: SendContent
  } = {}
): Promise<SendProgress> {
  // Reserved fields are the system's (booking link, preferences link, consent state).
  // Content never carries them, whatever was stored — stripped here as the last gate.
  const contentFields = stripReservedFields(options.content?.fields ?? campaign.merge_fields)
  const ctaMode: CtaMode = options.content?.ctaMode ?? 'booking'

  const bucket =
    options.bucket ??
    new TokenBucket({
      capacity: provider.capabilities.rateLimit.capacity,
      refillPerSecond: provider.capabilities.rateLimit.refillPerSecond,
    })

  const claimed = await claimCampaignSends(db, campaign, options.maxToProcess ?? 500, options.leaseSeconds)
  const progress: SendProgress = {
    total: claimed.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    uncertain: 0,
    remaining: 0,
    lost: 0,
  }

  const fail = async (row: ClaimedCampaignSend, reason: string) => {
    if (await complete(db, row, 'failed', { error: reason })) {
      progress.failureReason ??= reason
      progress.failed += 1
    } else {
      progress.lost += 1
    }
  }

  const defer = async (row: ClaimedCampaignSend, reason: string, retryAfterMs?: number) => {
    if (retryAfterMs) bucket.pauseFor(retryAfterMs)
    progress.deferredReason ??= reason
    if (await complete(db, row, 'pending', { error: reason })) progress.remaining += 1
    else progress.lost += 1
  }

  for (const row of claimed) {
    if (!row.email) {
      await fail(row, 'Contact has no email address.')
      continue
    }

    // Paced before the call, not after a 429 — the limit is known up front.
    await bucket.acquire()

    // Minted per attempt: only the token's hash is stored, so an earlier token cannot be
    // reconstructed on a retry. A superseded booking is harmless and expires.
    const mergeFields: Record<string, string> = { ...contentFields }

    // Only a booking email mints a booking. An external-link or no-CTA email never
    // creates one and never writes BookingUrl; its template must not reference it.
    if (ctaMode === 'booking' && options.baseUrl) {
      try {
        const { token } = await createBooking(db, { contactId: row.contact_id, campaignId: campaign.id })
        mergeFields[BOOKING_URL_MERGE_FIELD] = `${options.baseUrl.replace(/\/$/, '')}/book/${token}`
      } catch (bookingError) {
        // An email whose call to action is a dead link is worse than no email.
        await fail(row, bookingError instanceof Error ? bookingError.message : 'Could not create booking link.')
        continue
      }
    }

    // Personalisation lands on the contact first: the provider merges these fields into
    // a template it owns. An idempotent upsert, so its failures are safe to retry.
    if (Object.keys(mergeFields).length > 0) {
      const fieldOutcome = await provider.setContactFields(row.email, mergeFields)

      if (!fieldOutcome.ok) {
        if (fieldOutcome.retryable || fieldOutcome.ambiguous) {
          await defer(row, fieldOutcome.error, fieldOutcome.retryAfterMs)
        } else {
          await fail(row, fieldOutcome.error)
        }
        continue
      }
    }

    // Eligibility is re-checked here, atomically with recording the attempt: a consent
    // withdrawal that landed after the claim still stops this email (audit H4).
    const go = await beginDispatch(db, row)
    if (go === 'skipped') {
      progress.skipped += 1
      continue
    }
    if (go === 'lost') {
      progress.lost += 1
      continue
    }

    const outcome = await provider.triggerSend({
      campaignHandle: campaign.provider_automation_id ?? '',
      email: row.email,
      firstName: row.first_name ?? '',
      lastName: row.last_name ?? '',
    })

    if (outcome.ok) {
      if (await complete(db, row, 'sent', { reference: outcome.reference })) progress.sent += 1
      else progress.lost += 1
      continue
    }

    if (outcome.ambiguous) {
      if (await complete(db, row, 'uncertain', { error: outcome.error })) progress.uncertain += 1
      else progress.lost += 1
      continue
    }

    if (outcome.retryable) {
      await defer(row, outcome.error, outcome.retryAfterMs)
      continue
    }

    await fail(row, outcome.error)
  }

  return progress
}

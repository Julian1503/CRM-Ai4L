import type { SupabaseClient } from '@supabase/supabase-js'

import { createBooking } from '@/lib/booking/repository'
import type { CampaignRow, Database } from '@/lib/db/types'

import { BOOKING_URL_MERGE_FIELD } from './mergeFields'
import type { CampaignProvider } from './providers/types'
import { TokenBucket } from './rateLimiter'
import type { SegmentMember } from './segments'


/**
 * Campaign send fan-out.
 *
 * EmailOctopus has no broadcast send — the only trigger is
 * `POST /automations/{id}/queue`, addressed to one contact. So a "send" here is a loop
 * over the segment, paced against a token bucket, with every outcome written to
 * `campaign_sends`.
 *
 * The ledger is what makes this survivable:
 * - Resumable. Only `pending` rows are processed, so a run that dies mid-way picks up
 *   where it left off rather than re-sending to everyone.
 * - Deduplicated. `unique (campaign_id, contact_id)` is the guarantee, because with
 *   "Allow contacts to repeat" enabled the provider will happily send twice.
 * - Chunkable. `maxToProcess` bounds one invocation, so a 10k segment (~17 minutes of
 *   queueing) can be spread across scheduled runs rather than one long request.
 */

export type SendProgress = {
  total: number
  sent: number
  failed: number
  /** Rows this run touched but left `pending` because the failure was retryable. */
  remaining: number
  /**
   * Why a recipient failed, verbatim from the provider.
   *
   * Carried out of the loop because a chunk that returns `failed: 40` and nothing else
   * leaves an operator with no way to tell a missing merge field from a bad automation
   * id. The first one is kept rather than the last: with a systematic misconfiguration
   * every row fails the same way, and the first is the one that started it.
   */
  failureReason?: string
  /** Why work was deferred — a rate limit or a provider outage, not a bad request. */
  deferredReason?: string
}

type PendingSend = {
  id: string
  contact_id: string
  contact: { email: string; first_name: string; last_name: string } | null
}

/**
 * Creates one pending ledger row per segment member, for one run.
 *
 * Conflicts are ignored rather than erroring: re-preparing a campaign after adding
 * contacts to its segment should top up the ledger, not fail. The conflict target
 * includes `run`, so a second send to the same contact is a new row rather than a
 * silently ignored duplicate — that is what makes re-sending possible without losing
 * the first run's history.
 */
export async function prepareCampaignSends(
  db: SupabaseClient<Database>,
  campaignId: string,
  members: ReadonlyArray<Pick<SegmentMember, 'id' | 'email' | 'first_name' | 'last_name'>>,
  run = 1
): Promise<number> {
  if (members.length === 0) {
    return 0
  }

  const rows = members.map((member) => ({
    campaign_id: campaignId,
    contact_id: member.id,
    run,
    status: 'pending' as const,
  }))

  const { error } = await db
    .from('campaign_sends')
    .upsert(rows, { onConflict: 'campaign_id,contact_id,run', ignoreDuplicates: true })

  if (error) {
    throw new Error(`Could not prepare campaign sends: ${error.message}`)
  }

  return rows.length
}

/**
 * Processes pending sends for a campaign.
 *
 * A retryable failure leaves the row `pending` so a later run picks it up, and stalls
 * the whole bucket — backing off one call while the rest of the fan-out keeps firing
 * just prolongs the rate limiting. A non-retryable failure is recorded as `failed`,
 * since retrying a bad request only burns quota.
 */
export async function executeCampaignSends(
  db: SupabaseClient<Database>,
  provider: CampaignProvider,
  campaign: Pick<CampaignRow, 'id' | 'provider_automation_id' | 'merge_fields' | 'send_run'>,
  options: {
    maxToProcess?: number
    bucket?: TokenBucket
    /**
     * Origin for booking links, e.g. https://crm.example.com. When set, each recipient
     * gets a personal single-use booking link merged into their contact fields — this
     * is what connects a campaign to the consultation funnel.
     */
    baseUrl?: string
  } = {}
): Promise<SendProgress> {
  const maxToProcess = options.maxToProcess ?? 500
  const bucket =
    options.bucket ??
    new TokenBucket({
      capacity: provider.capabilities.rateLimit.capacity,
      refillPerSecond: provider.capabilities.rateLimit.refillPerSecond,
    })

  const { data, error } = await db
    .from('campaign_sends')
    .select('id, contact_id, contact:contacts(email, first_name, last_name)')
    .eq('campaign_id', campaign.id)
    // Scoped to the current run so a re-send cannot pick up a stray row from an
    // earlier one and email somebody a second time out of order.
    .eq('run', campaign.send_run ?? 1)
    .eq('status', 'pending')
    .limit(maxToProcess)

  if (error) {
    throw new Error(`Could not load pending sends: ${error.message}`)
  }

  const pending = (data ?? []) as unknown as PendingSend[]
  let sent = 0
  let failed = 0
  let failureReason: string | undefined
  let deferredReason: string | undefined

  const recordFailure = (reason: string) => {
    failureReason ??= reason
    failed += 1
  }

  for (const row of pending) {
    const contact = row.contact

    if (!contact?.email) {
      const reason = 'Contact has no email address.'
      await markSend(db, row.id, 'failed', { error: reason })
      recordFailure(reason)
      continue
    }

    // Paced before the call, not after a 429 — the limit is known up front.
    await bucket.acquire()

    // Mint the booking link for this recipient.
    //
    // Deliberately minted per attempt rather than reused: only the token's hash is
    // stored, so an earlier token cannot be reconstructed on a retry. A superseded
    // booking is harmless — its email never went out, and it expires on its own.
    const mergeFields: Record<string, string> = { ...(campaign.merge_fields ?? {}) }

    if (options.baseUrl) {
      try {
        const { token } = await createBooking(db, {
          contactId: row.contact_id,
          campaignId: campaign.id,
        })

        mergeFields[BOOKING_URL_MERGE_FIELD] = `${options.baseUrl.replace(/\/$/, '')}/book/${token}`
      } catch (bookingError) {
        // Sending an email whose call to action is a dead link is worse than not
        // sending it, so this fails the recipient rather than proceeding.
        const reason =
          bookingError instanceof Error
            ? bookingError.message
            : 'Could not create booking link.'

        await markSend(db, row.id, 'failed', { error: reason })
        recordFailure(reason)
        continue
      }
    }

    // Personalisation must land on the contact first: the provider merges these
    // fields into a template it owns, and cannot accept a body from us.
    if (Object.keys(mergeFields).length > 0) {
      const fieldOutcome = await provider.setContactFields(contact.email, mergeFields)

      if (!fieldOutcome.ok) {
        if (fieldOutcome.retryable) {
          if (fieldOutcome.retryAfterMs) bucket.pauseFor(fieldOutcome.retryAfterMs)
          deferredReason ??= fieldOutcome.error
          await noteDeferred(db, row.id, fieldOutcome.error)
          continue
        }

        await markSend(db, row.id, 'failed', { error: fieldOutcome.error })
        recordFailure(fieldOutcome.error)
        continue
      }
    }

    const outcome = await provider.triggerSend({
      campaignHandle: campaign.provider_automation_id ?? '',
      email: contact.email,
      firstName: contact.first_name ?? '',
      lastName: contact.last_name ?? '',
    })

    if (outcome.ok) {
      await markSend(db, row.id, 'sent', { reference: outcome.reference })
      sent += 1
      continue
    }

    if (outcome.retryable) {
      // Left pending on purpose so the next run retries it.
      if (outcome.retryAfterMs) bucket.pauseFor(outcome.retryAfterMs)
      deferredReason ??= outcome.error
      await noteDeferred(db, row.id, outcome.error)
      continue
    }

    await markSend(db, row.id, 'failed', { error: outcome.error })
    recordFailure(outcome.error)
  }

  return {
    total: pending.length,
    sent,
    failed,
    remaining: pending.length - sent - failed,
    failureReason,
    deferredReason,
  }
}

/**
 * Records why a recipient is still `pending`.
 *
 * A retryable failure used to leave no trace anywhere: the row stayed pending, the
 * chunk reported progress it had not made, and a send stalled behind a rate limit or a
 * provider outage looked identical to one still working through the queue. The note is
 * cleared by `markSend` as soon as the recipient succeeds.
 */
async function noteDeferred(
  db: SupabaseClient<Database>,
  id: string,
  reason: string
): Promise<void> {
  await db
    .from('campaign_sends')
    .update({ error: reason, attempted_at: new Date().toISOString() })
    .eq('id', id)
}

async function markSend(
  db: SupabaseClient<Database>,
  id: string,
  status: 'sent' | 'failed',
  details: { reference?: string | null; error?: string }
): Promise<void> {
  await db
    .from('campaign_sends')
    .update({
      status,
      provider_reference: details.reference ?? null,
      error: details.error ?? null,
      attempted_at: new Date().toISOString(),
    })
    .eq('id', id)
}

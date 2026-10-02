import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignRow, Database } from '@/lib/db/types'

import { isEmailDynamicEnabled } from '@/lib/content-studio/flags'

import { assessContent, ContentResolutionError, resolveSendContent, type ResolvedContent } from './campaignContent'
import { isSendable } from './campaignStatus'
import type { EmailOctopusCredentials } from './providers/credentials'
import { createEmailOctopusProvider } from './providers/emailOctopus'
import type { CampaignProvider } from './providers/types'
import { AudienceTooLargeError, prepareCampaignRun } from './runs'
import { executeCampaignSends, type SendProgress } from './send'
import { readCampaignSendSummary, type CampaignSendSummary } from './sendStatus'

/**
 * One step of a campaign send, shared by the operator's "Send now" / "Resume send" and
 * the scheduled worker (/api/cron/jobs). Either may drive a send; the atomic claims in
 * the ledger make it safe for both to run at once.
 *
 *   approved  → prepare the run's audience (resumable), requeue this run's failed rows,
 *               then move to sending — only if the approved revision is still current
 *   failed    → retry: back to approved under the ORIGINAL approval (the database
 *               refuses if the content changed since), then as above
 *   sending   → dispatch one chunk
 *
 * The campaign finishes `sent` only when every recipient is sent or skipped. Anything
 * failed or uncertain finishes it `failed`, and uncertain rows are never requeued by a
 * retry — a person reconciles them first.
 */

export type AdvanceOutcome =
  | { kind: 'not_found' }
  | { kind: 'conflict'; message: string }
  | {
      kind: 'progress'
      status: 'sending' | 'sent' | 'failed'
      progress: SendProgress
      summary: CampaignSendSummary
    }

type AdvanceOptions = {
  credentials: EmailOctopusCredentials
  /** Origin for booking links. Required only for campaigns whose CTA is a booking. */
  baseUrl: string | null
  chunkSize: number
  /** Injected in tests. */
  provider?: CampaignProvider
  /** Defaults to CONTENT_EMAIL_DYNAMIC_ENABLED. */
  dynamicEnabled?: boolean
}

async function requeueFailed(db: SupabaseClient<Database>, campaign: CampaignRow): Promise<void> {
  const { error } = await db
    .from('campaign_sends')
    .update({ status: 'pending', error: null, provider_reference: null, provider_attempted_at: null })
    .eq('campaign_id', campaign.id)
    .eq('run', campaign.send_run)
    .eq('status', 'failed')

  if (error) throw new Error(`Could not requeue failed recipients: ${error.message}`)
}

async function transition(
  db: SupabaseClient<Database>,
  campaign: CampaignRow,
  from: CampaignRow['status'],
  patch: Partial<CampaignRow>
): Promise<boolean> {
  const { data, error } = await db
    .from('campaigns')
    .update(patch)
    .eq('id', campaign.id)
    .eq('status', from)
    // Conditioned on the revision it was checked at: an edit landing in between voids
    // the approval (trigger) and this matches nothing.
    .eq('revision', campaign.revision)
    .select('id')
    .maybeSingle()

  if (error?.code === 'CRM04') return false
  if (error) throw new Error(error.message)

  return data !== null
}

export async function advanceCampaignSend(
  db: SupabaseClient<Database>,
  campaignId: string,
  options: AdvanceOptions
): Promise<AdvanceOutcome> {
  const { data, error: loadError } = await db
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle()

  if (loadError) throw new Error(loadError.message)
  const loaded = data as CampaignRow | null
  if (!loaded || loaded.removed_at) return { kind: 'not_found' }
  let campaign = loaded
  if (campaign.archived_at) {
    return { kind: 'conflict', message: 'This campaign is archived. Restore it before sending it.' }
  }

  const status = campaign.status
  if (status !== 'sending' && status !== 'failed' && !isSendable(status)) {
    return { kind: 'conflict', message: `A campaign in "${status}" cannot be sent. It must be approved first.` }
  }
  if (!campaign.segment_id) return { kind: 'conflict', message: 'This campaign has no segment.' }
  if (!campaign.provider_automation_id?.trim()) {
    return { kind: 'conflict', message: 'Set the EmailOctopus automation ID before sending.' }
  }
  if (campaign.approved_revision !== campaign.revision) {
    return {
      kind: 'conflict',
      message: 'This campaign changed after it was approved. Send it for review and approve it again.',
    }
  }

  // What this campaign sends. A Studio campaign's snapshot is re-assessed on every step,
  // so switching the dynamic-fields flag off stops new deliveries at once.
  let content: ResolvedContent
  try {
    content = await resolveSendContent(db, campaign)
  } catch (error) {
    if (error instanceof ContentResolutionError) return { kind: 'conflict', message: error.message }
    throw error
  }
  const problems = assessContent(content, { dynamicEnabled: options.dynamicEnabled ?? isEmailDynamicEnabled() })
  if (problems.length > 0) return { kind: 'conflict', message: problems.join(' ') }
  // A Studio booking email without an origin would send a dead button. (Hand-written
  // campaigns keep their long-standing behaviour: the callers always pass an origin.)
  if (content.snapshot && content.ctaMode === 'booking' && !options.baseUrl) {
    return { kind: 'conflict', message: 'Booking links need the app origin (NEXT_PUBLIC_APP_URL) before this campaign can send.' }
  }

  if (status === 'failed') {
    if (!(await transition(db, campaign, 'failed', { status: 'approved', completed_at: null }))) {
      return { kind: 'conflict', message: 'This campaign changed or was already claimed for retry. Reload and try again.' }
    }
    campaign = { ...campaign, status: 'approved' }
  }

  if (campaign.status === 'approved') {
    try {
      await prepareCampaignRun(db, campaign)
    } catch (error) {
      if (error instanceof AudienceTooLargeError) return { kind: 'conflict', message: error.message }
      if (error instanceof Error && /matches no subscribed contacts/.test(error.message)) {
        return { kind: 'conflict', message: error.message }
      }
      throw error
    }

    // Failed recipients of this run are retried under the current approval. Uncertain
    // ones are not: they may already have the email.
    await requeueFailed(db, campaign)

    if (!(await transition(db, campaign, 'approved', { status: 'sending', started_at: new Date().toISOString() }))) {
      return { kind: 'conflict', message: 'This campaign is already being sent, or changed since it was approved.' }
    }
  }

  const provider = options.provider ?? createEmailOctopusProvider(options.credentials)
  const progress = await executeCampaignSends(db, provider, campaign, {
    maxToProcess: options.chunkSize,
    baseUrl: options.baseUrl ?? undefined,
    content: { fields: content.fields, ctaMode: content.ctaMode },
  })

  const summary = await readCampaignSendSummary(db, campaign.id)
  let finalStatus: 'sending' | 'sent' | 'failed' = 'sending'

  if (summary.pending === 0) {
    finalStatus = summary.failed > 0 || summary.uncertain > 0 ? 'failed' : 'sent'
    const { error: completionError } = await db
      .from('campaigns')
      .update({ status: finalStatus, completed_at: new Date().toISOString() })
      .eq('id', campaign.id)
      .eq('status', 'sending')

    if (completionError) throw new Error(completionError.message)
  }

  return { kind: 'progress', status: finalStatus, progress, summary }
}

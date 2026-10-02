import type { CampaignStatus } from '@/lib/db/types'

/**
 * Campaign status machine.
 *
 * Mirrors the trigger in 20260808000000_segments_and_campaigns.sql. The database is the
 * enforcement point — sending is irreversible, so an unapproved campaign must not reach
 * 'sending' through *any* path, including a direct SQL edit. This copy exists so the UI
 * can disable impossible actions instead of discovering them through an exception.
 *
 * Keep the two in step; the tests assert the shapes match.
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['in_review'],
  in_review: ['draft', 'approved'],
  approved: ['draft', 'sending'],
  sending: ['sent', 'failed'],
  failed: ['draft', 'approved'],
  // Re-opening a sent campaign returns it to draft rather than straight to approved:
  // the audience may have changed since it went out, so the human gate is crossed
  // again. `sent` used to be terminal, which froze a campaign forever.
  sent: ['draft'],
}

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from]?.includes(to) ?? false
}

export type ApprovalCandidate = {
  status: CampaignStatus
  providerAutomationId: string | null
  segmentId: string | null
  /**
   * Why the content cannot be sent as it stands (a Studio snapshot that fails its
   * contract, or a delivery mode that is switched off). Empty or omitted: none.
   */
  contentProblems?: readonly string[]
}

export type ApprovalCheck = { ok: true } | { ok: false; reason: string }

/**
 * Whether a campaign is ready to be approved.
 *
 * The automation id is required because EmailOctopus cannot create a campaign through
 * its API — the automation is authored in their UI with the "Started via API" trigger,
 * and without its id there is nothing to queue contacts into. Approving without it
 * produces a campaign that can never send.
 */
export function checkApprovable(campaign: ApprovalCandidate): ApprovalCheck {
  if (!canTransition(campaign.status, 'approved')) {
    return {
      ok: false,
      reason: `A campaign in "${campaign.status}" cannot be approved.`,
    }
  }

  if (!campaign.segmentId) {
    return { ok: false, reason: 'Select a segment before approving.' }
  }

  if (!campaign.providerAutomationId?.trim()) {
    return {
      ok: false,
      reason:
        'Set the provider automation id before approving. EmailOctopus cannot create a ' +
        'campaign via API, so the automation must be authored in EmailOctopus with the ' +
        '"Started via API" trigger and its id recorded here.',
    }
  }

  if (campaign.contentProblems && campaign.contentProblems.length > 0) {
    return { ok: false, reason: campaign.contentProblems.join(' ') }
  }

  return { ok: true }
}

/** Only an approved campaign may begin sending. */
export function isSendable(status: CampaignStatus): boolean {
  return canTransition(status, 'sending')
}

/**
 * Whether a campaign can be re-opened for another send.
 *
 * Only a completed one. A failed campaign has "Retry failed" instead, which requeues
 * the recipients that failed rather than emailing everybody a second time.
 */
export function canReopen(status: CampaignStatus): boolean {
  return status === 'sent'
}

/** Terminal states no longer change. */
export function isTerminal(status: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[status].length === 0
}

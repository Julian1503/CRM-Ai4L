import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignContentSnapshotRow, CampaignRow, Database } from '@/lib/db/types'

import type { SendContent } from './send'
import {
  deliveryProblem,
  findContract,
  LEGACY_V1,
  linkProblem,
  validateCopy,
  type CtaMode,
  type TemplateContract,
} from './templateContracts'

/**
 * What a campaign sends, and whether it may be approved or sent.
 *
 * Hand-written campaigns (no snapshot) send their merge fields under legacy-v1 with a
 * booking CTA — exactly as before contracts existed, with no extra reads. A Content
 * Studio campaign sends its immutable snapshot: the fields, CTA mode and contract the
 * snapshot recorded, never the campaign's mirror of them.
 */

type Db = SupabaseClient<Database>

export type ResolvedContent = SendContent & {
  contract: TemplateContract
  snapshot: CampaignContentSnapshotRow | null
  contentHash: string | null
}

type ContentCampaign = Pick<CampaignRow, 'merge_fields'> & { content_snapshot_id?: string | null }

export class ContentResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentResolutionError'
  }
}

export async function loadSnapshot(db: Db, snapshotId: string): Promise<CampaignContentSnapshotRow> {
  const { data, error } = await db.from('campaign_content_snapshots').select('*').eq('id', snapshotId).maybeSingle()
  if (error) throw new Error(`Could not read the campaign content: ${error.message}`)
  if (!data) throw new ContentResolutionError('This campaign\'s Content Studio snapshot no longer exists.')
  return data as CampaignContentSnapshotRow
}

export async function resolveSendContent(db: Db, campaign: ContentCampaign): Promise<ResolvedContent> {
  if (!campaign.content_snapshot_id) {
    return { fields: campaign.merge_fields ?? {}, ctaMode: 'booking', contract: LEGACY_V1, snapshot: null, contentHash: null }
  }

  const snapshot = await loadSnapshot(db, campaign.content_snapshot_id)
  const contract = findContract(snapshot.contract_id, snapshot.contract_version)
  if (!contract) {
    throw new ContentResolutionError(`This campaign uses contract "${snapshot.contract_id}" v${snapshot.contract_version}, which this CRM does not know.`)
  }

  return {
    fields: snapshot.fields ?? {},
    ctaMode: snapshot.cta_mode as CtaMode,
    contract,
    snapshot,
    contentHash: snapshot.content_hash,
  }
}

/**
 * Every reason this content cannot be approved or sent now. Empty means it can.
 *
 * Legacy campaigns are not assessed here: their rules are unchanged (the copy editor and
 * PATCH validate them). Studio content is re-validated against its contract, its CTA is
 * checked, and the dynamic-fields mode is refused while the provider validation flag is
 * off (plan §8.2).
 */
export function assessContent(content: ResolvedContent, options: { dynamicEnabled: boolean; imagePrefix?: string | null }): string[] {
  const { snapshot, contract, ctaMode } = content
  if (!snapshot) return []

  const problems: string[] = []
  if (snapshot.purpose !== 'campaign') problems.push('An HTML export cannot be sent as a campaign.')

  const delivery = deliveryProblem(contract, ctaMode, { dynamicEnabled: options.dynamicEnabled })
  if (delivery) problems.push(delivery)

  const validation = validateCopy(contract, snapshot.fields ?? {}, { ctaMode, imagePrefix: options.imagePrefix })
  if (!validation.ok) problems.push(...validation.errors)

  if (ctaMode === 'external_url') {
    const problem = snapshot.cta_url ? linkProblem(snapshot.cta_url) : 'is missing.'
    if (problem) problems.push(`The button link ${problem}`)
    const urlSlot = contract.slots.find((slot) => slot.role === 'cta_url')
    if (urlSlot && snapshot.fields?.[urlSlot.tag] !== snapshot.cta_url) {
      problems.push('The button link in the fields does not match the approved link.')
    }
  }

  return problems
}

export type CampaignContentSummary = {
  snapshotId: string
  contract: { id: string; version: number; label: string; delivery: TemplateContract['delivery'] }
  ctaMode: CtaMode
  ctaUrl: string | null
  subject: string | null
  fields: Record<string, string>
  assets: CampaignContentSnapshotRow['assets']
  contentHash: string
  sourceRevisionId: string
  sourceRevisionNumber: number | null
  /** The Content Studio item the email came from, for a link back; null if unreadable. */
  sourceItemId: string | null
  renderedHtml: string | null
  renderedText: string | null
  createdAt: string
}

/** What the Campaigns screen shows for a Studio email: its snapshot and where it came from. */
export async function readCampaignContentSummary(db: Db, snapshotId: string): Promise<CampaignContentSummary> {
  const snapshot = await loadSnapshot(db, snapshotId)
  const contract = findContract(snapshot.contract_id, snapshot.contract_version)

  const { data: revision } = await db
    .from('content_variant_revisions')
    .select('id, variant_id, revision_number')
    .eq('id', snapshot.source_revision_id)
    .maybeSingle()
  const { data: variant } = revision
    ? await db.from('content_variants').select('id, item_id').eq('id', revision.variant_id).maybeSingle()
    : { data: null }

  return {
    snapshotId: snapshot.id,
    contract: {
      id: snapshot.contract_id,
      version: snapshot.contract_version,
      label: contract?.label ?? snapshot.contract_id,
      delivery: contract?.delivery ?? 'static',
    },
    ctaMode: snapshot.cta_mode as CtaMode,
    ctaUrl: snapshot.cta_url,
    subject: snapshot.subject,
    fields: snapshot.fields ?? {},
    assets: snapshot.assets ?? [],
    contentHash: snapshot.content_hash,
    sourceRevisionId: snapshot.source_revision_id,
    sourceRevisionNumber: revision?.revision_number ?? null,
    sourceItemId: variant?.item_id ?? null,
    renderedHtml: snapshot.rendered_html,
    renderedText: snapshot.rendered_text,
    createdAt: snapshot.created_at,
  }
}

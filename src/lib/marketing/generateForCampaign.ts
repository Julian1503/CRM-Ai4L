import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignRow, Database } from '@/lib/db/types'

import { generateCampaignCopy, type GenerationUsage, type MessagesApi } from './generateCampaign'
import type { ScheduleBrief } from './prompt'
import { parseSegmentCriteria } from './segmentCriteria'
import { measureSegmentAudience } from './segments'
import { resolveContract, type TemplateContract } from './templateContracts'

/**
 * Writes copy for one campaign and stores it.
 *
 * Shared by the "Write copy with AI" route and the newsletter scheduler, so a scheduled
 * issue is written by exactly the path an operator's is — same audience description,
 * same validation, same rule that rewriting sends the campaign back to draft.
 *
 * Returns the two outcomes a caller answers differently (`not_found`, `conflict`) and
 * throws for everything else, so a failure carries its own message to the log or the
 * 500 without a third kind of result to forget to handle.
 */

/** Statuses whose copy may still be rewritten. */
const EDITABLE_STATUSES = new Set(['draft', 'in_review', 'failed'])

export type GenerateForCampaignOutcome =
  | {
      ok: true
      campaign: CampaignRow
      generation: { attempts: number; usage: GenerationUsage }
      audience: { size: number; truncated: boolean }
    }
  | { ok: false; reason: 'not_found' | 'conflict'; message: string }

export async function generateForCampaign(
  db: SupabaseClient<Database>,
  messages: MessagesApi,
  campaignId: string,
  schedule?: ScheduleBrief
): Promise<GenerateForCampaignOutcome> {
  const { data: campaign, error: loadError } = await db
    .from('campaigns')
    .select(
      'id, name, status, notes, segment_id, consent_stream, template_id, content_snapshot_id, segment:segments(name, description, definition)'
    )
    .eq('id', campaignId)
    .maybeSingle()

  if (loadError) throw new Error(loadError.message)
  if (!campaign) return { ok: false, reason: 'not_found', message: 'Campaign not found.' }

  if (!EDITABLE_STATUSES.has(campaign.status)) {
    // Regenerating an approved campaign would swap the copy out from under the person
    // who approved it, leaving the approval attributed to text they never saw.
    return {
      ok: false,
      reason: 'conflict',
      message: `A campaign in "${campaign.status}" cannot be rewritten. Move it back to draft first.`,
    }
  }

  // A Studio email's copy is its snapshot; rewriting it here would bypass the Studio's
  // review and the snapshot hash the approval binds to.
  if (campaign.content_snapshot_id) {
    return {
      ok: false,
      reason: 'conflict',
      message: "This campaign's content comes from the Content Studio. Edit it there and create a new email.",
    }
  }

  const contract = await loadContract(db, campaign.template_id)
  if (contract.delivery !== 'legacy') {
    return {
      ok: false,
      reason: 'conflict',
      message: 'This template takes its content from the Content Studio, so the CRM does not write its copy.',
    }
  }

  const segment = (campaign as unknown as {
    segment: { name: string; description: string | null; definition: unknown } | null
  }).segment

  if (!campaign.segment_id || !segment) {
    return {
      ok: false,
      reason: 'conflict',
      message: 'Select a segment before generating copy — it defines the audience.',
    }
  }

  const audience = await measureSegmentAudience(
    db,
    { id: campaign.segment_id, definition: segment.definition },
    campaign.consent_stream
  )

  if (audience.total === 0) {
    return {
      ok: false,
      reason: 'conflict',
      message: 'This segment currently matches no contacts, so there is no audience to write for.',
    }
  }

  const filters = parseSegmentCriteria(segment.definition)

  // Ids resolved to names. The segment stores UUIDs, and handing the model a UUID is
  // worse than handing it nothing — it is noise that looks like information, and
  // "write to 3d02ab78-194e-481f" steers nothing.
  const [jobTypeName, organisationName, serviceName] = await Promise.all([
    nameOf(db, 'job_types', filters.jobTypeId),
    nameOf(db, 'organisations', filters.organisationId),
    nameOf(db, 'services', filters.serviceId),
  ])

  const result = await generateCampaignCopy(messages, {
    campaignName: campaign.name,
    notes: campaign.notes,
    consentStream: campaign.consent_stream,
    schedule,
    audience: {
      segmentName: segment.name,
      segmentDescription: segment.description,
      size: audience.total,
      jobType: jobTypeName,
      organisation: organisationName,
      service: serviceName,
      state: filters.state,
      status: filters.status,
      search: filters.q,
    },
  }, { contract })

  if (!result.ok) throw new Error(result.error)

  // Replaces `merge_fields` outright rather than merging: the generated copy is the whole
  // contract, and a leftover value from a previous generation would merge into the
  // template beside the new copy without anything flagging the mismatch. The booking
  // link is not lost by this — it is added per recipient at send time.
  //
  // Status drops back to `draft` on purpose. Rewriting copy that was already in review
  // invalidates the review, and the reviewer should see the new text as new.
  const { data: updated, error: saveError } = await db
    .from('campaigns')
    .update({
      merge_fields: result.copy,
      subject: result.copy.Headline ?? null,
      status: 'draft',
    })
    .eq('id', campaignId)
    .eq('status', campaign.status)
    .select('*')
    .single()

  if (saveError) throw new Error(saveError.message)

  return {
    ok: true,
    campaign: updated as CampaignRow,
    generation: { attempts: result.attempts, usage: result.usage },
    audience: { size: audience.total, truncated: audience.truncated },
  }
}

/** The template's contract; no template means the built-in legacy-v1. */
async function loadContract(db: SupabaseClient<Database>, templateId: string | null): Promise<TemplateContract> {
  if (!templateId) return resolveContract(null)

  const { data, error } = await db
    .from('campaign_templates')
    .select('contract_id, contract_version')
    .eq('id', templateId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return resolveContract(data)
}

async function nameOf(
  db: SupabaseClient<Database>,
  table: 'job_types' | 'organisations' | 'services',
  id: string | null
): Promise<string | null> {
  if (!id) return null

  const { data } = await db.from(table).select('name').eq('id', id).maybeSingle()

  return (data as { name?: string } | null)?.name ?? null
}

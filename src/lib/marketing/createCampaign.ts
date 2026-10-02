import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignRow, ConsentStream, Database } from '@/lib/db/types'
import { isArchiveRuleError } from '@/lib/lifecycle/lifecycle'

import { resolveContract, UnknownContractError, validateCopy, type TemplateContract } from './templateContracts'

/**
 * Creating a hand-made (or scheduled) campaign draft, shared by POST /api/campaigns and
 * the newsletter scheduler so both apply the same rules:
 *
 *   - the consent stream, automation and contract come from the template, never the
 *     caller; without a template the caller names the stream explicitly;
 *   - merge fields are checked against the template's contract. A draft may be empty or
 *     partial (copy is usually generated afterwards), but reserved fields (BookingUrl,
 *     PrefsUrl, Newsletter, Courses), unknown keys and over-long values are refused —
 *     before this, POST stored any string key and the sender spread it onto the contact;
 *   - status is never accepted: the database only inserts drafts.
 *
 * Content Studio emails are not created here. Their content is a snapshot, created in
 * one transaction with the campaign by `create_content_email_snapshot`; a Studio
 * template is refused so its campaigns cannot exist without one.
 */

type Db = SupabaseClient<Database>

export type CampaignSource =
  | { kind: 'template'; templateId: string }
  | { kind: 'manual'; automationId: string | null; stream: ConsentStream }
  /** A template the caller has already loaded and checked (the scheduler). */
  | { kind: 'resolved'; templateId: string; automationId: string | null; stream: ConsentStream; contract: TemplateContract }

export type CreateCampaignInput = {
  name: string
  segmentId: string | null
  source: CampaignSource
  mergeFields?: Record<string, unknown>
  subject?: string | null
  notes?: string | null
  scheduleId?: string | null
  scheduledFor?: string | null
}

export type CreateCampaignOutcome =
  | { ok: true; campaign: CampaignRow }
  | { ok: false; reason: 'bad_request' | 'segment_archived' | 'duplicate'; message: string }

type ResolvedSource = { templateId: string | null; automationId: string | null; stream: ConsentStream; contract: TemplateContract }

async function resolveSource(db: Db, source: CampaignSource): Promise<ResolvedSource | { error: string }> {
  if (source.kind === 'resolved') return source
  if (source.kind === 'manual') {
    return { templateId: null, automationId: source.automationId, stream: source.stream, contract: resolveContract(null) }
  }

  const { data: template, error } = await db
    .from('campaign_templates')
    .select('id, provider_automation_id, consent_stream, archived_at, contract_id, contract_version')
    .eq('id', source.templateId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!template || template.archived_at) return { error: 'That template does not exist or has been archived.' }

  let contract: TemplateContract
  try {
    contract = resolveContract(template)
  } catch (contractError) {
    if (contractError instanceof UnknownContractError) return { error: contractError.message }
    throw contractError
  }

  return {
    templateId: template.id,
    automationId: template.provider_automation_id,
    stream: template.consent_stream,
    contract,
  }
}

/** String values only: anything else was never a merge value. */
function stringFields(input: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {})
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, String(value)])
  )
}

export async function createCampaign(db: Db, input: CreateCampaignInput): Promise<CreateCampaignOutcome> {
  const name = input.name.trim()
  if (!name) return { ok: false, reason: 'bad_request', message: 'A campaign name is required.' }

  const resolved = await resolveSource(db, input.source)
  if ('error' in resolved) return { ok: false, reason: 'bad_request', message: resolved.error }

  if (resolved.contract.delivery !== 'legacy') {
    return {
      ok: false,
      reason: 'bad_request',
      message: 'This template takes its content from the Content Studio. Create the email there instead.',
    }
  }

  const fields = stringFields(input.mergeFields)
  let mergeFields: Record<string, string> = {}

  if (Object.keys(fields).length > 0) {
    const validation = validateCopy(resolved.contract, fields, { partial: true })
    if (!validation.ok) return { ok: false, reason: 'bad_request', message: validation.errors.join(' ') }
    mergeFields = validation.value
  }

  const { data, error } = await db
    .from('campaigns')
    .insert({
      name,
      segment_id: input.segmentId,
      template_id: resolved.templateId,
      provider_automation_id: resolved.automationId,
      subject: input.subject ?? null,
      notes: input.notes ?? null,
      // Frozen on the campaign rather than read from its template at send time: a
      // template that is later re-pointed must not change who a campaign may reach.
      consent_stream: resolved.stream,
      merge_fields: mergeFields,
      ...(input.scheduleId ? { schedule_id: input.scheduleId, scheduled_for: input.scheduledFor ?? null } : {}),
    })
    .select('*')
    .single()

  if (error?.code === '23505') return { ok: false, reason: 'duplicate', message: 'This campaign already exists.' }
  if (isArchiveRuleError(error)) {
    return { ok: false, reason: 'segment_archived', message: error?.message ?? 'That segment is archived.' }
  }
  if (error) throw new Error(error.message)

  return { ok: true, campaign: data as CampaignRow }
}

import type { NextRequest, NextResponse } from 'next/server'

import { badRequest, conflict, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import {
  BOOKING_URL_MERGE_FIELD,
  CAMPAIGN_COPY_FIELDS,
  PREFERENCES_URL_MERGE_FIELD,
  RESERVED_MERGE_FIELDS,
} from '@/lib/marketing/mergeFields'
import { loadEmailOctopusCredentials } from '@/lib/marketing/providers/credentials'
import { createMergeField, listMergeTags } from '@/lib/marketing/providers/emailOctopus'
import {
  findMissingContractFields,
  requiredProviderFields,
  resolveContract,
  TEMPLATE_CONTRACTS,
  UnknownContractError,
  type TemplateContract,
} from '@/lib/marketing/templateContracts'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Merge-field setup for the EmailOctopus list.
 *
 * This exists because the failure it prevents is silent. A campaign whose template
 * references `{{Headline}}` on a list with no `Headline` field does not error — it
 * sends, with an empty line where the headline should be. Nothing in the send ledger,
 * the provider's reporting, or the CRM would show it. The only way to know is to ask
 * the list what fields it has, so that is what this does.
 *
 * GET reports. POST creates whatever is missing, which is the one-time setup step
 * PLAN.md flagged as required before booking links can work at all.
 */

/** Labels used when creating a field, keyed by tag. */
const LABELS: Record<string, string> = {
  ...Object.fromEntries(TEMPLATE_CONTRACTS.flatMap((contract) => contract.slots.map((slot) => [slot.tag, slot.label]))),
  ...Object.fromEntries(CAMPAIGN_COPY_FIELDS.map((field) => [field.tag, field.label])),
  [BOOKING_URL_MERGE_FIELD]: 'Booking link',
  [PREFERENCES_URL_MERGE_FIELD]: 'Email preferences link',
  Newsletter: 'Subscribed to newsletter',
  Courses: 'Subscribed to courses',
}

/**
 * The fields to check. Without `?templateId=` it is the classic set (the seven copy
 * fields plus every reserved field) exactly as before; with one, the fields that
 * template's contract needs (`requiredProviderFields`).
 */
async function readRequirement(
  request: NextRequest | undefined
): Promise<{ contract: TemplateContract | null } | { error: NextResponse }> {
  const templateId = request?.nextUrl?.searchParams.get('templateId')?.trim()
  if (!templateId) return { contract: null }

  const db = await createSupabaseServerClient()
  const { data, error } = await db
    .from('campaign_templates')
    .select('id, contract_id, contract_version, removed_at')
    .eq('id', templateId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data || data.removed_at) return { error: badRequest('That template does not exist.') }

  try {
    return { contract: resolveContract(data) }
  } catch (contractError) {
    if (contractError instanceof UnknownContractError) return { error: conflict(contractError.message) }
    throw contractError
  }
}

function required(contract: TemplateContract | null): string[] {
  return contract
    ? requiredProviderFields(contract)
    : [...CAMPAIGN_COPY_FIELDS.map((field) => field.tag), ...RESERVED_MERGE_FIELDS]
}

function missingFrom(contract: TemplateContract | null, tags: readonly string[]): string[] {
  if (contract) return findMissingContractFields(contract, tags)
  const present = new Set(tags.map((tag) => tag.toLowerCase()))
  return required(null).filter((tag) => !present.has(tag.toLowerCase()))
}

export async function GET(request?: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const credentials = await loadEmailOctopusCredentials()

    if (!credentials) {
      return conflict('EmailOctopus credentials are not configured in Settings.')
    }

    const requirement = await readRequirement(request)
    if ('error' in requirement) return requirement.error

    const result = await listMergeTags(credentials)

    if (!result.ok) {
      return serverError(new Error(result.error), 'Could not read the EmailOctopus list.')
    }

    const missing = missingFrom(requirement.contract, result.tags)

    return ok({
      tags: result.tags,
      missing,
      ready: missing.length === 0,
      required: required(requirement.contract),
      ...(requirement.contract ? { contract: requirement.contract.id } : {}),
    })
  } catch (error) {
    return serverError(error, 'Could not check EmailOctopus merge fields.')
  }
}

/** Creates the missing fields. Idempotent: an already-present tag is not touched. */
export async function POST(request?: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const credentials = await loadEmailOctopusCredentials()

    if (!credentials) {
      return conflict('EmailOctopus credentials are not configured in Settings.')
    }

    const requirement = await readRequirement(request)
    if ('error' in requirement) return requirement.error

    const existing = await listMergeTags(credentials)

    if (!existing.ok) {
      return serverError(new Error(existing.error), 'Could not read the EmailOctopus list.')
    }

    const missing = missingFrom(requirement.contract, existing.tags)
    const created: string[] = []
    const failed: { tag: string; error: string }[] = []

    for (const tag of missing) {
      const result = await createMergeField({
        ...credentials,
        tag,
        label: LABELS[tag] ?? tag,
      })

      if (result.ok) created.push(tag)
      else failed.push({ tag, error: result.error })
    }

    return ok({ created, failed, ready: failed.length === 0 })
  } catch (error) {
    return serverError(error, 'Could not create EmailOctopus merge fields.')
  }
}

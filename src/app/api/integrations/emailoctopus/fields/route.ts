import type { NextRequest, NextResponse } from 'next/server'

import { conflict, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import {
  BOOKING_URL_MERGE_FIELD,
  CAMPAIGN_COPY_FIELDS,
  RESERVED_MERGE_FIELDS,
  findMissingMergeFields,
} from '@/lib/marketing/mergeFields'
import { createMergeField, listMergeTags } from '@/lib/marketing/providers/emailOctopus'
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
  ...Object.fromEntries(CAMPAIGN_COPY_FIELDS.map((field) => [field.tag, field.label])),
  [BOOKING_URL_MERGE_FIELD]: 'Booking link',
}

type Credentials = { apiKey: string; listId: string }

async function loadCredentials(): Promise<Credentials | null> {
  const db = await createSupabaseServerClient()
  const { data, error } = await db.from('credentials').select('key, value')

  if (error) throw new Error(error.message)

  const byKey = Object.fromEntries(
    (data ?? []).map((row) => [row.key, row.value])
  ) as Record<string, string>

  const apiKey = byKey.emailoctopus_api_key?.trim()
  const listId = byKey.emailoctopus_list_id?.trim()

  return apiKey && listId ? { apiKey, listId } : null
}

export async function GET(): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const credentials = await loadCredentials()

    if (!credentials) {
      return conflict('EmailOctopus credentials are not configured in Settings.')
    }

    const result = await listMergeTags(credentials)

    if (!result.ok) {
      return serverError(new Error(result.error), 'Could not read the EmailOctopus list.')
    }

    const missing = findMissingMergeFields(result.tags)

    return ok({
      tags: result.tags,
      missing,
      ready: missing.length === 0,
      required: [
        ...CAMPAIGN_COPY_FIELDS.map((field) => field.tag),
        ...RESERVED_MERGE_FIELDS,
      ],
    })
  } catch (error) {
    return serverError(error, 'Could not check EmailOctopus merge fields.')
  }
}

/** Creates the missing fields. Idempotent: an already-present tag is not touched. */
export async function POST(_request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const credentials = await loadCredentials()

    if (!credentials) {
      return conflict('EmailOctopus credentials are not configured in Settings.')
    }

    const existing = await listMergeTags(credentials)

    if (!existing.ok) {
      return serverError(new Error(existing.error), 'Could not read the EmailOctopus list.')
    }

    const missing = findMissingMergeFields(existing.tags)
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

import type { NextRequest, NextResponse } from 'next/server'

import { badRequest, conflict, forbidden, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { applyContactTags, parseBulkTagInput } from '@/lib/contacts/tagRepository'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Adds or removes tags on an explicit selection of contacts: `{ contactIds, tagIds,
 * operation: 'add' | 'remove' }`.
 *
 * All or nothing, in one transaction (apply_contact_tags). A selection that went stale
 * (a contact archived or gone, a tag gone) is refused as a whole with 409 so the user
 * refreshes rather than getting a partial update. Repeating a request is a no-op;
 * `updated` counts only contacts whose tags actually changed.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)
  if (!body) return badRequest('Expected a JSON object.')

  const parsed = parseBulkTagInput(body)
  if (!parsed.ok) return badRequest(parsed.error)

  try {
    const db = await createSupabaseServerClient()
    const result = await applyContactTags(db, parsed.input)

    if (result.kind === 'invalid') return badRequest(result.message)
    if (result.kind === 'stale') return conflict(result.message)
    if (result.kind === 'forbidden') return forbidden()

    return ok({ updated: result.updated })
  } catch (error) {
    return serverError(error, 'Could not update tags. Nothing was changed.')
  }
}

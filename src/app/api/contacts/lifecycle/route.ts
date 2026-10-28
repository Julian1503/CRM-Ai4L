import type { NextRequest, NextResponse } from 'next/server'

import { badRequest, conflict, forbidden, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { applyBulkLifecycle, parseBulkLifecycleInput } from '@/lib/contacts/bulkLifecycle'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Archives or removes an explicit selection of contacts: `{ contactIds, action:
 * 'archive' | 'remove' }`. Both are soft deletes; nothing is ever physically deleted.
 *
 * One transaction (set_contacts_lifecycle). Contacts already archived or removed meanwhile
 * are skipped and counted; a contact an archive rule protects refuses the whole request
 * with 409 naming the reason.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)
  if (!body) return badRequest('Expected a JSON object.')

  const parsed = parseBulkLifecycleInput(body)
  if (!parsed.ok) return badRequest(parsed.error)

  try {
    const db = await createSupabaseServerClient()
    const result = await applyBulkLifecycle(db, parsed.input)

    if (result.kind === 'invalid') return badRequest(result.message)
    if (result.kind === 'conflict') return conflict(result.message)
    if (result.kind === 'forbidden') return forbidden()

    return ok({ updated: result.updated, skipped: result.skipped, action: parsed.input.action })
  } catch (error) {
    return serverError(error, `Could not ${parsed.input.action} the contacts. Nothing was changed.`)
  }
}

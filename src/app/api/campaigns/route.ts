import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import { badRequest, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/** Lists campaigns with their segment name. */
export async function GET(): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const db = await createSupabaseServerClient()
    const { data, error } = await db
      .from('campaigns')
      .select('*, segment:segments(name)')
      .order('created_at', { ascending: false })

    if (error) throw new Error(error.message)

    return ok({ campaigns: data ?? [] })
  } catch (error) {
    return serverError(error, 'Could not load campaigns.')
  }
}

/**
 * Creates a campaign as a draft.
 *
 * Status is never accepted from the caller — the database trigger rejects any insert
 * that is not `draft`, and the approval gate is the only way forward.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)

  if (!body) {
    return badRequest('Expected a JSON object.')
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''

  if (!name) {
    return badRequest('A campaign name is required.')
  }

  const mergeFields =
    typeof body.mergeFields === 'object' && body.mergeFields !== null
      ? Object.fromEntries(
          Object.entries(body.mergeFields as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string')
            .map(([key, value]) => [key, String(value)])
        )
      : {}

  try {
    const db = await createSupabaseServerClient()

    const { data, error } = await db
      .from('campaigns')
      .insert({
        name,
        segment_id: typeof body.segmentId === 'string' ? body.segmentId : null,
        provider_automation_id:
          typeof body.providerAutomationId === 'string'
            ? body.providerAutomationId.trim()
            : null,
        subject: typeof body.subject === 'string' ? body.subject.trim() : null,
        notes: typeof body.notes === 'string' ? body.notes.trim() : null,
        merge_fields: mergeFields,
      })
      .select('*')
      .single()

    if (error) throw new Error(error.message)

    return ok({ campaign: data })
  } catch (error) {
    return serverError(error, 'Could not create campaign.')
  }
}

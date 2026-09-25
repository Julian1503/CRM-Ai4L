import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import { badRequest, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { readConsentStream } from '@/lib/marketing/consentStream'
import { buildPageMeta, getPageRange, readPageParams } from '@/lib/pagination'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Lists campaigns with their segment name, newest first.
 *
 * Bounded: campaigns accumulate and are never deleted, so an unbounded read would
 * eventually hit PostgREST's silent 1000-row cap.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const db = await createSupabaseServerClient()
    const pageParams = readPageParams(request.nextUrl.searchParams)
    const { from, to } = getPageRange(pageParams)

    const { data, error, count } = await db
      .from('campaigns')
      .select('*, segment:segments(name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw new Error(error.message)

    return ok({ campaigns: data ?? [], ...buildPageMeta(pageParams, count ?? 0) })
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
        // Frozen on the campaign rather than read from its template at send time: a
        // template that is later re-pointed must not change who a campaign was allowed
        // to reach. Unrecognised values fall back to the newsletter.
        consent_stream: readConsentStream(body.consentStream),
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

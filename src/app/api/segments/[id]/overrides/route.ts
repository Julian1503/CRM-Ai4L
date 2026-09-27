import type { NextRequest, NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import type { SegmentOverrideRow } from '@/lib/db/types'
import { describeLock, findLockingCampaigns, isSegmentLockError } from '@/lib/marketing/segmentLock'
import { buildPageMeta, readPageParams } from '@/lib/pagination'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

const MODES: SegmentOverrideRow['mode'][] = ['include', 'exclude']
const MAX_REASON = 300

/**
 * Manual decisions about who is in a segment.
 *
 * An inclusion adds someone the criteria miss; an exclusion removes someone they match.
 * Neither touches consent: an included contact who never agreed to a stream still gets
 * nothing on that stream. One decision per person per segment, so switching a person
 * from included to excluded is a single call.
 */
export async function GET(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const mode = request.nextUrl.searchParams.get('mode')
  const pageParams = readPageParams(request.nextUrl.searchParams, 25)
  const from = (pageParams.page - 1) * pageParams.pageSize

  try {
    const db = await createSupabaseServerClient()
    let query = db
      .from('segment_overrides')
      .select('contact_id, mode, reason, created_at', { count: 'exact' })
      .eq('segment_id', id)

    if (mode === 'include' || mode === 'exclude') query = query.eq('mode', mode)

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, from + pageParams.pageSize - 1)

    if (error) throw new Error(error.message)

    const rows = data ?? []
    const ids = rows.map((row) => row.contact_id)
    const { data: contacts, error: contactError } = ids.length
      ? await db
          .from('contacts')
          .select('id, first_name, last_name, email, subscribed_to_newsletter, subscribed_to_programs, deleted_at')
          .in('id', ids)
      : { data: [], error: null }

    if (contactError) throw new Error(contactError.message)

    const byId = new Map((contacts ?? []).map((contact) => [contact.id, contact]))

    return ok({
      overrides: rows.map((row) => ({ ...row, contact: byId.get(row.contact_id) ?? null })),
      ...buildPageMeta(pageParams, count ?? 0),
    })
  } catch (error) {
    return serverError(error, 'Could not load the manual decisions.')
  }
}

export async function POST(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  const contactId = typeof body.contactId === 'string' ? body.contactId.trim() : ''
  const mode = MODES.find((candidate) => candidate === body.mode)
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON) || null : null

  if (!contactId) return badRequest('contactId is required.')
  if (!mode) return badRequest('mode must be "include" or "exclude".')

  try {
    const db = await createSupabaseServerClient()
    const lockedBy = await findLockingCampaigns(db, id)

    if (lockedBy.length > 0) return conflict(describeLock(lockedBy))

    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('id, subscribed_to_newsletter, subscribed_to_programs')
      .eq('id', contactId)
      .is('deleted_at', null)
      .maybeSingle()

    if (contactError) throw new Error(contactError.message)
    if (!contact) return notFound('That contact does not exist or is archived.')

    const { data, error } = await db
      .from('segment_overrides')
      .upsert(
        { segment_id: id, contact_id: contactId, mode, reason, created_by: guard.session.userId },
        { onConflict: 'segment_id,contact_id' }
      )
      .select('contact_id, mode, reason, created_at')
      .single()

    if (isSegmentLockError(error)) return conflict(error?.message ?? 'The segment is locked.')
    // A foreign-key failure here means the segment itself is gone.
    if (error?.code === '23503') return notFound('Segment not found.')
    if (error) throw new Error(error.message)

    return ok({
      override: data,
      // So the panel can say plainly when an inclusion will not reach someone.
      consent: {
        newsletter: contact.subscribed_to_newsletter,
        programs: contact.subscribed_to_programs,
      },
    })
  } catch (error) {
    return serverError(error, 'Could not save the manual decision.')
  }
}

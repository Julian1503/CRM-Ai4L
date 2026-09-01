import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import {
  badRequest,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import type { CampaignTemplateRow } from '@/lib/db/types'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Renames a template, re-points it at another automation, or archives it.
 *
 * There is no DELETE, and the table grants no delete policy: a campaign that has
 * already sent still references the template its copy was written for, and dropping
 * the row would make that copy uninterpretable. `archived: true` retires it from the
 * pickers instead, and is reversible.
 */
export async function PATCH(
  request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  const patch: Partial<CampaignTemplateRow> = {}

  if (typeof body.name === 'string') {
    const name = body.name.trim()

    if (!name) return badRequest('A template name is required.')

    patch.name = name
  }

  if (typeof body.providerAutomationId === 'string') {
    const automationId = body.providerAutomationId.trim()

    if (!automationId) {
      return badRequest('An EmailOctopus automation ID is required.')
    }

    patch.provider_automation_id = automationId
  }

  if (typeof body.description === 'string') {
    patch.description = body.description.trim() || null
  }

  if (typeof body.archived === 'boolean') {
    patch.archived_at = body.archived ? new Date().toISOString() : null
  }

  if (Object.keys(patch).length === 0) {
    return badRequest('Nothing to update.')
  }

  // The table has no updated_at trigger, by the same convention as segments and
  // campaigns: the writer sets it.
  patch.updated_at = new Date().toISOString()

  try {
    const db = await createSupabaseServerClient()

    const { data, error } = await db
      .from('campaign_templates')
      .update(patch)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: `A template named "${patch.name}" already exists.` },
          { status: 409, headers: NO_STORE }
        )
      }

      throw new Error(error.message)
    }

    if (!data) return notFound('Template not found.')

    return ok({ template: data })
  } catch (error) {
    return serverError(error, 'Could not update the email template.')
  }
}

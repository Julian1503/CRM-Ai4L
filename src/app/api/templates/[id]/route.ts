import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  readJsonBody,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import type { CampaignTemplateRow } from '@/lib/db/types'
import { findTemplateUsers, templateLifecycle } from '@/lib/lifecycle/entityLifecycle'
import {
  isArchiveRuleError,
  lifecyclePatch,
  readLifecycleAction,
  refusal,
  type LifecycleAction,
} from '@/lib/lifecycle/lifecycle'
import { parseConsentStream } from '@/lib/marketing/consentStream'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Renames a template, re-points it at another automation or moves it to another consent
 * stream; or, on its own, archives, restores or removes it (`{ archived: boolean }`,
 * `{ removed: true }`).
 *
 * There is no DELETE, and the table grants no delete policy: a campaign that has
 * already sent still references the template its copy was written for, and dropping
 * the row would make that copy uninterpretable. Archiving retires it from the pickers
 * and is reversible; removing also hides it from the registry, for good. Both are
 * refused while a live newsletter schedule drafts with it.
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

  const lifecycle = readLifecycleAction(body)

  if (lifecycle.kind === 'invalid') return badRequest(lifecycle.error)
  if (lifecycle.kind !== 'none') return changeLifecycle(id, lifecycle.kind, guard.session.userId)

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

  // Safe to change: campaigns copy the stream at creation, so only campaigns created
  // from now on follow the template to its new stream.
  if (body.consentStream !== undefined) {
    const consentStream = parseConsentStream(body.consentStream)

    if (!consentStream) return badRequest('Unknown consent stream.')

    patch.consent_stream = consentStream
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
      .is('removed_at', null)
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

async function changeLifecycle(id: string, action: LifecycleAction, userId: string): Promise<NextResponse> {
  try {
    const db = await createSupabaseServerClient()
    const { data: template, error: loadError } = await db
      .from('campaign_templates')
      .select('id, name, archived_at, removed_at')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!template || template.removed_at) return notFound('Template not found.')

    const schedules = template.archived_at ? [] : await findTemplateUsers(db, id)
    const refused = refusal(action, templateLifecycle(template, schedules))

    if (refused) return conflict(refused)

    const { data, error } = await db
      .from('campaign_templates')
      .update({ ...lifecyclePatch(action, template, userId), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (isArchiveRuleError(error)) return conflict(error?.message ?? 'The template is in use.')
    if (error?.code === '23505') {
      return conflict(`A template named "${template.name}" already exists. Rename that one before restoring this.`)
    }
    if (error) throw new Error(error.message)
    if (!data) return notFound('Template not found.')

    return ok({ template: data })
  } catch (error) {
    return serverError(error, 'Could not change the email template.')
  }
}

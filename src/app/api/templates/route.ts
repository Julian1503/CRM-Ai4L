import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { badRequest, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { parseConsentStream } from '@/lib/marketing/consentStream'
import { BUILT_IN_TEMPLATE_SLOTS } from '@/lib/marketing/templates'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * The named registry over EmailOctopus automation ids.
 *
 * See `src/lib/marketing/templates.ts` for why names have to live on this side: the
 * provider exposes no endpoint that lists automations, so nothing can populate a
 * picker except what an operator records here once.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Lists templates, oldest first.
 *
 * Archived rows are excluded by default — an archived template is one an operator has
 * retired, and offering it in a picker is the whole thing archiving prevents. Sent
 * campaigns still reference it, which is why the row is kept rather than deleted.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const includeArchived = request.nextUrl.searchParams.get('includeArchived') === 'true'

  try {
    const db = await createSupabaseServerClient()
    let query = db.from('campaign_templates').select('*').order('created_at', { ascending: true })

    if (!includeArchived) {
      query = query.is('archived_at', null)
    }

    const { data, error } = await query

    if (error) throw new Error(error.message)

    return ok({ templates: data ?? [] })
  } catch (error) {
    return serverError(error, 'Could not load email templates.')
  }
}

/**
 * Registers a template: a human name against an automation id.
 *
 * The automation id is *not* verified here. Verification is a live provider round trip
 * that can answer "unknown" when EmailOctopus is slow or rate-limiting, and refusing to
 * save a correct name because the provider was briefly unreachable would be worse than
 * saving a row the operator can see is unverified. The UI checks before saving and the
 * registry shows the current state of every row.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  const name = typeof body.name === 'string' ? body.name.trim() : ''

  if (!name) return badRequest('A template name is required.')

  const automationId =
    typeof body.providerAutomationId === 'string' ? body.providerAutomationId.trim() : ''

  if (!automationId) {
    return badRequest('An EmailOctopus automation ID is required.')
  }

  // Required rather than defaulted: every campaign built on this template inherits it,
  // so a silent default would misfile a course template under the newsletter.
  const consentStream = parseConsentStream(body.consentStream)

  if (!consentStream) {
    return badRequest('Choose which consent stream this template sends to.')
  }

  try {
    const db = await createSupabaseServerClient()

    const { data, error } = await db
      .from('campaign_templates')
      .insert({
        name,
        description: typeof body.description === 'string' ? body.description.trim() || null : null,
        provider_automation_id: automationId,
        consent_stream: consentStream,
        // Registering a name does not yet mean designing a new slot set; every
        // template starts on the contract the copy generator already writes for.
        slots: BUILT_IN_TEMPLATE_SLOTS,
      })
      .select('*')
      .single()

    if (error) {
      // Unique index on lower(btrim(name)) — two templates sharing a name would make
      // the picker a coin flip.
      if (error.code === '23505') {
        return NextResponse.json(
          { error: `A template named "${name}" already exists.` },
          { status: 409, headers: NO_STORE }
        )
      }

      throw new Error(error.message)
    }

    return ok({ template: data })
  } catch (error) {
    return serverError(error, 'Could not create the email template.')
  }
}

import type { NextResponse } from 'next/server'

import {
  badRequest,
  ok,
  readJsonBody,
  requireAdminOr403,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import {
  loadEmailOctopusStatus,
  parseEmailOctopusUpdate,
  saveEmailOctopusUpdate,
} from '@/lib/marketing/providers/credentials'

export const runtime = 'nodejs'

/**
 * EmailOctopus connection settings (audit H1).
 *
 * GET tells any approved member whether the integration is configured. It never returns
 * the API key — not masked, not truncated — because nothing in the browser needs it.
 *
 * PUT replaces the settings and is limited to administrators. The key is write-only:
 * `{ apiKey: { action: 'unchanged' | 'replace' | 'clear', value? }, listId }`.
 */
export async function GET(): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    return ok({
      ...(await loadEmailOctopusStatus()),
      canEdit: guard.session.role === 'admin',
    })
  } catch (error) {
    console.error('Could not read EmailOctopus settings status:', error)
    return serverError(null, 'Could not read the EmailOctopus settings.')
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const guard = await requireAdminOr403()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)
  if (!body) return badRequest('Expected a JSON body.')

  const parsed = parseEmailOctopusUpdate(body)
  if (!parsed.ok) return badRequest(parsed.error)

  try {
    await saveEmailOctopusUpdate(parsed.update)
    return ok({ ...(await loadEmailOctopusStatus()), canEdit: true })
  } catch (error) {
    console.error('Could not save EmailOctopus settings:', error)
    return serverError(null, 'Could not save the EmailOctopus settings.')
  }
}

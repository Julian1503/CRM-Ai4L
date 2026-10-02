import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'

import { forbidden, readJsonBody } from '@/lib/api/responses'
import type { Session } from '@/lib/auth/dal'
import { isUuid } from '@/lib/contacts/tags'
import { contentErrorResponse, ContentHttpError, featureDisabled } from '@/lib/content-studio/errors'
import { enabledSocialPlatforms, isContentStudioEnabled } from '@/lib/content-studio/flags'
import { getDefaultBrand } from '@/lib/content-studio/repository'
import type { ListAccountsResponse } from '@/lib/content-studio/types'
import { json, readValidBody } from '@/lib/content-studio/userRoute'
import type { Database } from '@/lib/db/types'
import { getAdminClient } from '@/lib/supabase/admin'
import { createSupabaseServerClient } from '@/lib/supabase/server'

import { disconnectSocialAccount, listSocialAccounts, saveConnectedAccounts } from './accounts'
import { EngineError, exchangeCode, requestAuthorizeUrl } from './engineClient'
import { callbackUrl, isSameOrigin, settingsRedirect } from './oauthHttp'
import { consumeOAuthState, createOAuthState, isProviderAllowed, parseOAuthOptions } from './oauthState'
import { runPreflight } from './preflight'
import { listPublications, requestPublication } from './publications'
import { parsePublishRequest } from './validation'

/**
 * The work behind every /api/social route. Each route file authenticates the caller
 * itself (requireSessionOr401 — the security sweep checks for it) and hands the session
 * here. The service-role client is confined to this module and only used after that
 * check: for OAuth state, account writes, encrypted tokens and public image copies.
 */

type Db = SupabaseClient<Database>

const MAX_CODE_LENGTH = 4096

export const isAdmin = (session: Session): boolean => session.role === 'admin'

// --- Accounts ---------------------------------------------------------------------

/** Available while the studio flag is off, so administrators can connect accounts first. */
export async function listAccountsResponse(): Promise<NextResponse> {
  try {
    const accounts = await listSocialAccounts(await createSupabaseServerClient())
    const body: ListAccountsResponse = { accounts, enabledPlatforms: enabledSocialPlatforms() }
    return json(body)
  } catch (error) {
    return contentErrorResponse(error, 'Could not load the social accounts.')
  }
}

export async function disconnectAccountResponse(session: Session, request: NextRequest, rawId: string): Promise<NextResponse> {
  if (!isAdmin(session)) return forbidden('Only an administrator can do that.')
  try {
    if (!isUuid(rawId)) throw new ContentHttpError(404, 'Account not found.')
    const body = await readJsonBody(request)
    if (body?.action !== 'disconnect') throw new ContentHttpError(400, "Expected { action: 'disconnect' }.")
    return json({ account: await disconnectSocialAccount(getAdminClient(), rawId, session.userId) })
  } catch (error) {
    return contentErrorResponse(error, 'Could not disconnect the account.')
  }
}

// --- OAuth ----------------------------------------------------------------------------

async function readConnectOptions(request: NextRequest): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? ''
  try {
    if (type.includes('application/json')) {
      const body = await readJsonBody(request)
      return body ?? {}
    }
    if (type.includes('form')) return Object.fromEntries((await request.formData()).entries())
  } catch {
    return {}
  }
  return {}
}

function failureReason(error: unknown, fallback: string): string {
  const reason = error instanceof EngineError ? error.code : fallback
  console.error('Social connect failed:', reason)
  return reason
}

/** Creates a single-use state, asks the engine for the consent URL and redirects there. */
export async function startConnectResponse(session: Session, request: NextRequest, provider: string): Promise<NextResponse> {
  if (!isAdmin(session)) return forbidden('Only an administrator can do that.')
  if (!isSameOrigin(request)) return settingsRedirect(request, 'error', { reason: 'cross_site' })
  if (!isProviderAllowed(provider)) return settingsRedirect(request, 'error', { reason: 'unknown_provider' })
  const options = parseOAuthOptions(provider, await readConnectOptions(request))
  if (!options) return settingsRedirect(request, 'error', { reason: 'invalid_options' })

  try {
    const brand = await getDefaultBrand(await createSupabaseServerClient())
    const state = await createOAuthState(getAdminClient(), { provider, actorId: session.userId, brandId: brand.id, options })
    const url = await requestAuthorizeUrl(provider, { state, redirectUri: callbackUrl(request, provider), options })
    const response = NextResponse.redirect(url, 303)
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch (error) {
    return settingsRedirect(request, 'error', { reason: failureReason(error, 'start_failed') })
  }
}

/**
 * Consumes the state (single use, unexpired, this administrator), exchanges the code
 * through the engine and stores the accounts. The code, state and tokens never reach a
 * response or a log line; Settings gets a short result code.
 */
export async function connectCallbackResponse(session: Session, request: NextRequest, provider: string): Promise<NextResponse> {
  if (!isAdmin(session)) return settingsRedirect(request, 'error', { reason: 'not_authorised' })
  if (!isProviderAllowed(provider)) return settingsRedirect(request, 'error', { reason: 'unknown_provider' })

  const params = request.nextUrl.searchParams
  const state = params.get('state') ?? ''
  const code = params.get('code') ?? ''
  const admin: Db = getAdminClient()

  try {
    const consumed = state ? await consumeOAuthState(admin, { state, provider, actorId: session.userId }) : null
    if (!consumed) return settingsRedirect(request, 'error', { reason: 'invalid_state' })
    if (params.get('error')) return settingsRedirect(request, 'error', { reason: 'denied' })
    if (!code || code.length > MAX_CODE_LENGTH) return settingsRedirect(request, 'error', { reason: 'missing_code' })

    const accounts = await exchangeCode(provider, { code, redirectUri: callbackUrl(request, provider), options: consumed.options })
    if (accounts.length === 0) return settingsRedirect(request, 'error', { reason: 'no_accounts' })

    const saved = await saveConnectedAccounts(admin, { accounts, provider, brandId: consumed.brandId, actorId: session.userId })
    return settingsRedirect(request, 'connected', { count: saved.length })
  } catch (error) {
    return settingsRedirect(request, 'error', { reason: failureReason(error, 'connect_failed') })
  }
}

// --- Publications (behind the Content Studio flag) -------------------------------------

async function withStudio(fallback: string, handler: (db: Db) => Promise<NextResponse>): Promise<NextResponse> {
  if (!isContentStudioEnabled()) return featureDisabled()
  try {
    return await handler(await createSupabaseServerClient())
  } catch (error) {
    return contentErrorResponse(error, fallback)
  }
}

export function listPublicationsResponse(request: NextRequest): Promise<NextResponse> {
  return withStudio('Could not load the publications.', async (db) => {
    const itemId = request.nextUrl.searchParams.get('itemId')
    if (itemId !== null && !isUuid(itemId)) throw new ContentHttpError(400, 'itemId must be a UUID.')
    return json({ publications: await listPublications(db, itemId) })
  })
}

export function createPublicationResponse(session: Session, request: NextRequest): Promise<NextResponse> {
  return withStudio('Could not request the publication.', async (db) => {
    const body = await readValidBody(request, parsePublishRequest)
    return json({ publication: await requestPublication(db, getAdminClient(), session.userId, body) }, 202)
  })
}

export function preflightResponse(request: NextRequest): Promise<NextResponse> {
  return withStudio('Could not check the post.', async (db) => {
    const body = await readValidBody(request, parsePublishRequest)
    const { preflight } = await runPreflight(db, getAdminClient(), body)
    return json({ preflight })
  })
}

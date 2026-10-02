import 'server-only'

import { NextResponse, type NextRequest } from 'next/server'

import type { SocialProvider } from '@/lib/content-studio/types'

/**
 * URLs of the browser leg of the OAuth flow. The callback must match what is registered
 * with Meta/LinkedIn, so it is built from NEXT_PUBLIC_APP_URL when set (a proxy may show
 * the request under an internal host), falling back to the request origin.
 */

type Env = Record<string, string | undefined>

export type ConnectOutcome = 'connected' | 'error'

export function appOrigin(request: NextRequest, env: Env = process.env): string {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through to the request origin
    }
  }
  return request.nextUrl.origin
}

export function callbackUrl(request: NextRequest, provider: SocialProvider, env: Env = process.env): string {
  return `${appOrigin(request, env)}/api/social/oauth/${provider}/callback`
}

/**
 * Back to Settings with a short, non-sensitive result: `social=connected|error` plus a
 * machine `reason` or `count`. Never a provider message, code or token.
 */
export function settingsRedirect(
  request: NextRequest,
  outcome: ConnectOutcome,
  detail: { reason?: string; count?: number } = {},
  env: Env = process.env
): NextResponse {
  const url = new URL('/', appOrigin(request, env))
  url.searchParams.set('view', 'settings')
  url.searchParams.set('social', outcome)
  if (detail.reason) url.searchParams.set('reason', detail.reason)
  if (detail.count !== undefined) url.searchParams.set('count', String(detail.count))
  const response = NextResponse.redirect(url, 303)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

/** A cross-site form post must not start a connection with the admin's cookies. */
export function isSameOrigin(request: NextRequest, env: Env = process.env): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return request.headers.get('sec-fetch-site') !== 'cross-site'
  return origin === request.nextUrl.origin || origin === appOrigin(request, env)
}

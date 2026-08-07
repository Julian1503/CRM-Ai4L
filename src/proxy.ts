import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { isApiPath, isPublicPath, isWebhookPath } from '@/lib/auth/routes'
import { getSupabaseConfig } from '@/lib/supabase/config'

/**
 * Authentication gate and Supabase session refresh.
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy`; the file must be named
 * proxy.ts and export a function named `proxy`. It runs on the Node.js runtime by
 * default and the `runtime` segment option is not allowed here.
 *
 * This is an OPTIMISTIC check. Per the Next.js docs, Server Functions are POSTs to the
 * route they live on and can fall outside the matcher, so a matcher change or a refactor
 * can silently remove coverage. Real authorisation lives in the Data Access Layer
 * (src/lib/auth/dal.ts), which every data path calls.
 *
 * It also refreshes the Supabase session on each request. Cookies cannot be written from
 * Server Components, so without this the access token would expire and never renew.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl

  // Third-party webhooks have no session and authenticate by signature instead.
  if (isWebhookPath(pathname)) {
    return NextResponse.next()
  }

  // Sign-in routes must stay reachable or the redirect below loops forever.
  if (isPublicPath(pathname)) {
    return NextResponse.next()
  }

  const supabaseConfig = getSupabaseConfig()

  // Fail closed: an auth gate with no auth backend denies rather than admits.
  if (!supabaseConfig) {
    return deny(request, 'not-configured')
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(supabaseConfig.url, supabaseConfig.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        // Both halves are required: the request copy so the current pass sees the
        // refreshed token, and the response copy so the browser stores it. Omitting
        // setAll causes random logouts that are notoriously hard to trace.
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value)
        })
        response = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options)
        })
      },
    },
  })

  let user = null
  try {
    // getUser() revalidates against the auth server. getSession() would only decode
    // the cookie, which is forgeable.
    const result = await supabase.auth.getUser()
    user = result.data.user
  } catch {
    // Auth server unreachable or malformed cookie — deny rather than 500.
    return deny(request)
  }

  if (!user) {
    return deny(request)
  }

  // Responses here may carry refreshed Set-Cookie headers; a shared CDN cache must
  // never serve one user's session cookie to another.
  response.headers.set('Cache-Control', 'private, no-store')

  return response
}

/** 401 for API routes, redirect to /login for pages. */
function deny(request: NextRequest, reason?: string): NextResponse {
  if (isApiPath(request.nextUrl.pathname)) {
    return NextResponse.json(
      {
        error:
          reason === 'not-configured'
            ? 'Authentication is unavailable because Supabase is not configured.'
            : 'Authentication required.',
      },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } }
    )
  }

  const loginUrl = new URL('/login', request.nextUrl.origin)

  // Round-trip the intended destination. Only the path and query are carried, never a
  // full URL, so this cannot be turned into an open redirect.
  const intended = `${request.nextUrl.pathname}${request.nextUrl.search}`
  if (intended !== '/') {
    loginUrl.searchParams.set('next', intended)
  }

  if (reason) {
    loginUrl.searchParams.set('reason', reason)
  }

  const response = NextResponse.redirect(loginUrl)
  response.headers.set('Cache-Control', 'private, no-store')

  return response
}

export const config = {
  // Everything except static assets and metadata files. Webhook and public-route
  // exemptions are handled in code above rather than in this regex, so they can be
  // unit tested (see src/lib/auth/routes.test.ts).
  //
  // Note: Next.js still runs the proxy for /_next/data routes even when excluded here,
  // deliberately, so protecting a page also protects its data route.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
}

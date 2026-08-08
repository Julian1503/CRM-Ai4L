import { NextResponse } from 'next/server'

import { getSession, type Session } from '@/lib/auth/dal'

/**
 * Shared response shapes for JSON API routes.
 *
 * Every route re-checks the session itself rather than trusting proxy.ts — the Next.js
 * docs warn that Server Functions can fall outside a proxy matcher, so the gate is
 * optimistic by design and the real check belongs next to the data.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: 'Authentication required.' },
    { status: 401, headers: NO_STORE }
  )
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE })
}

export function notFound(message = 'Not found.'): NextResponse {
  return NextResponse.json({ error: message }, { status: 404, headers: NO_STORE })
}

export function conflict(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 409, headers: NO_STORE })
}

export function ok(body: unknown): NextResponse {
  return NextResponse.json(body, { headers: NO_STORE })
}

export function serverError(error: unknown, fallback = 'Request failed.'): NextResponse {
  const message = error instanceof Error ? error.message : fallback

  return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE })
}

/**
 * Resolves the session, or returns the 401 to send back.
 *
 * Callers do `const guard = await requireSessionOr401(); if ('response' in guard) return
 * guard.response`, which keeps the check impossible to forget silently.
 */
export async function requireSessionOr401(): Promise<
  { session: Session } | { response: NextResponse }
> {
  const session = await getSession()

  if (!session) {
    return { response: unauthorized() }
  }

  return { session }
}

/** Reads a JSON body, returning null when it is absent or malformed. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json()

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return null
    }

    return body as Record<string, unknown>
  } catch {
    return null
  }
}

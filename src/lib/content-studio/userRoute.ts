import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

import { readJsonBody } from '@/lib/api/responses'
import type { Session } from '@/lib/auth/dal'
import { isUuid } from '@/lib/contacts/tags'
import type { Database } from '@/lib/db/types'
import { createSupabaseServerClient } from '@/lib/supabase/server'

import { contentErrorResponse, ContentHttpError, featureDisabled } from './errors'
import { isContentStudioEnabled } from './flags'
import type { Body, Parsed } from './validation'

/**
 * The shared shape of every /api/content-studio route:
 *   1. the route checks the session and membership first with requireSessionOr401()
 *      (401 before any database work),
 *   2. the feature flag is checked (404 feature_disabled while the studio is off),
 *   3. the handler runs with the member's own client, so RLS applies,
 *   4. every error goes through contentErrorResponse (SQLSTATE → status + code).
 * The service-role client is used only inside the lib (Storage signing and copies),
 * after step 1.
 */

type Db = SupabaseClient<Database>

/** Next 16: dynamic route params are a Promise. */
export type IdContext = { params: Promise<{ id: string }> }

export type ContentRequestContext = { session: Session; db: Db }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

/**
 * Runs a Content Studio handler for a session the route has already resolved with
 * requireSessionOr401() — kept in each route, next to the data, so the structural
 * security test (src/lib/security.test.ts) can see every route authenticate.
 */
export async function runContentRoute(
  session: Session,
  fallback: string,
  handler: (context: ContentRequestContext) => Promise<NextResponse>
): Promise<NextResponse> {
  if (!isContentStudioEnabled()) return featureDisabled()

  try {
    const db = await createSupabaseServerClient()
    return await handler({ session, db })
  } catch (error) {
    return contentErrorResponse(error, fallback)
  }
}

/** The `[id]` segment, or a 404 for anything that is not a UUID (it cannot exist). */
export async function readRouteId(context: IdContext, label = 'Not found.'): Promise<string> {
  const { id } = await context.params
  if (!isUuid(id)) throw new ContentHttpError(404, label)
  return id
}

/** Reads and validates a JSON body; throws a 400 on anything malformed. */
export async function readValidBody<T>(request: Request, parse: (body: Body) => Parsed<T>): Promise<T> {
  const body = await readJsonBody(request)
  if (!body) throw new ContentHttpError(400, 'Expected a JSON object.')

  const parsed = parse(body)
  if (!parsed.ok) throw new ContentHttpError(400, parsed.error)
  return parsed.value
}

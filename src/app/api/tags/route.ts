import { NextResponse, type NextRequest } from 'next/server'

import { badRequest, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { createTag, listTags } from '@/lib/contacts/tagRepository'
import { describeTagError, normalizeTagName, validateTagName } from '@/lib/contacts/tags'
import { readPageParams } from '@/lib/pagination'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/** No tag name is longer, so a longer search term cannot match anything. */
const MAX_QUERY_LENGTH = 80

/**
 * The CRM tag catalog, paginated. Pickers search it rather than loading everything:
 * the catalog is not assumed to fit in one page.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const params = request.nextUrl.searchParams
  const q = params.get('q')?.trim().slice(0, MAX_QUERY_LENGTH) || null
  const page = readPageParams(params)

  try {
    const db = await createSupabaseServerClient()
    const { tags, total } = await listTags(db, { ...page, q })

    return ok({ tags, total, page: page.page, pageSize: page.pageSize, hasMore: page.page * page.pageSize < total })
  } catch (error) {
    return serverError(error, 'Could not load tags.')
  }
}

/**
 * Finds or creates a tag by name. 201 when it was created; 200 with `created: false`
 * when a tag with the same name (ignoring case and spaces) already existed, including
 * one a concurrent request created a moment earlier. Either way the caller gets the id.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const body = await readJsonBody(request)
  if (!body) return badRequest('Expected a JSON object.')
  if (typeof body.name !== 'string') return badRequest('name is required.')

  const name = normalizeTagName(body.name)
  if (name === '') return badRequest('A tag name is required.')

  const invalid = validateTagName(name)
  if (invalid) return badRequest(describeTagError(invalid))

  try {
    const db = await createSupabaseServerClient()
    const result = await createTag(db, name)

    if (result.kind === 'invalid') return badRequest(result.message)

    return NextResponse.json(
      { tag: result.tag, created: result.created },
      { status: result.created ? 201 : 200, headers: { 'Cache-Control': 'private, no-store' } }
    )
  } catch (error) {
    return serverError(error, 'Could not create the tag.')
  }
}

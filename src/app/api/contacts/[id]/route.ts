import { NextResponse, type NextRequest } from 'next/server'

import { getSession } from '@/lib/auth/dal'
import { badRequest, conflict, notFound, ok, readJsonBody, requireSessionOr401, serverError } from '@/lib/api/responses'
import { archiveContact, restoreContact } from '@/lib/contacts/repository'
import { handleContactSave } from '@/lib/contacts/saveHandler'
import { contactLifecycle } from '@/lib/lifecycle/entityLifecycle'
import { isArchiveRuleError, lifecyclePatch, readLifecycleAction, refusal } from '@/lib/lifecycle/lifecycle'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

// Next.js 16: dynamic route params are delivered as a Promise.
type RouteContext = { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

async function authorise(): Promise<NextResponse | null> {
  const session = await getSession()

  if (!session) {
    return NextResponse.json(
      { error: 'Authentication required.' },
      { status: 401, headers: NO_STORE }
    )
  }

  return null
}

/**
 * Archives a contact (soft delete).
 *
 * DELETE is the honest verb for the user's intent, but the row is retained with
 * `deleted_at` set — there is no hard-delete path anywhere in the application. Removing
 * a contact for good is `PATCH { removed: true }`, which is a soft delete too.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const unauthorised = await authorise()
  if (unauthorised) return unauthorised

  const { id } = await params

  if (!id) {
    return NextResponse.json({ error: 'Contact id is required.' }, { status: 400 })
  }

  try {
    const db = await createSupabaseServerClient()
    await archiveContact(db, id)

    return NextResponse.json({ ok: true, archived: id }, { headers: NO_STORE })
  } catch (error) {
    console.error('Archive contact failed:', error)

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not archive contact.' },
      { status: 500, headers: NO_STORE }
    )
  }
}

/** Restores an archived contact. */
export async function POST(
  _request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const unauthorised = await authorise()
  if (unauthorised) return unauthorised

  const { id } = await params

  if (!id) {
    return NextResponse.json({ error: 'Contact id is required.' }, { status: 400 })
  }

  try {
    const db = await createSupabaseServerClient()
    await restoreContact(db, id)

    return NextResponse.json({ ok: true, restored: id }, { headers: NO_STORE })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not restore contact.'

    // An email collision is a conflict the user can resolve, not a server fault.
    const isConflict = /already an active contact/i.test(message)

    if (!isConflict) {
      console.error('Restore contact failed:', error)
    }

    return NextResponse.json(
      { error: message },
      { status: isConflict ? 409 : 500, headers: NO_STORE }
    )
  }
}

/**
 * Archives, restores or removes a contact: `{ archived: boolean }` or `{ removed: true }`.
 *
 * Removing hides the contact everywhere, including the archive screen, and cannot be
 * undone from the application. Nothing is deleted: its sends, bookings and consent
 * history stay intact, and an import of the same address later starts a new record
 * that never has more consent than this one had.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  const body = await readJsonBody(request)

  if (!body) return badRequest('Expected a JSON object.')

  const action = readLifecycleAction(body)

  if (action.kind === 'invalid') return badRequest(action.error)
  if (action.kind === 'none') return badRequest('Send { archived: boolean } or { removed: true }.')

  try {
    const db = await createSupabaseServerClient()
    const { data: contact, error: loadError } = await db
      .from('contacts')
      .select('id, deleted_at, removed_at')
      .eq('id', id)
      .maybeSingle()

    if (loadError) throw new Error(loadError.message)
    if (!contact || contact.removed_at) return notFound('Contact not found.')

    const refused = refusal(action.kind, contactLifecycle(contact))

    if (refused) return conflict(refused)

    // A contact's archive column is `deleted_at`; the shared patch speaks `archived_at`.
    const { archived_at: deletedAt, ...removal } = lifecyclePatch(
      action.kind,
      { archived_at: contact.deleted_at },
      guard.session.userId
    )

    const { data, error } = await db
      .from('contacts')
      .update({ deleted_at: deletedAt, ...removal })
      .eq('id', id)
      .select('id, deleted_at, removed_at, archive_reason')
      .maybeSingle()

    if (error?.code === '23505') {
      return conflict(
        'There is already an active contact with that email address. Archive or update the other record first.'
      )
    }
    if (isArchiveRuleError(error)) return conflict(error?.message ?? 'This contact cannot change right now.')
    if (error) throw new Error(error.message)
    if (!data) return notFound('Contact not found.')

    return ok({ contact: data })
  } catch (error) {
    return serverError(error, 'Could not change the contact.')
  }
}

/**
 * Replaces a contact's details, organisation and services in one transaction (audit H8).
 * Requires `expectedRevision`: saving over someone else's newer edit is a 409, and a
 * failure anywhere leaves the contact exactly as it was.
 */
export async function PUT(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  return handleContactSave(request, id, request.nextUrl.origin)
}

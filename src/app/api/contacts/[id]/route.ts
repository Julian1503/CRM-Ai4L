import { NextResponse, type NextRequest } from 'next/server'

import { getSession } from '@/lib/auth/dal'
import { archiveContact, restoreContact } from '@/lib/contacts/repository'
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
 * `deleted_at` set — there is no hard-delete path anywhere in the application.
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

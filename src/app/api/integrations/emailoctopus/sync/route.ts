import { NextResponse, type NextRequest } from 'next/server'

import { getSession } from '@/lib/auth/dal'
import { syncContactToEmailOctopus, type SubscriptionStatus } from '@/lib/emailOctopus'

export const runtime = 'nodejs'

// The error list echoes contact email addresses, so responses must not be cached.
const NO_STORE = { 'Cache-Control': 'private, no-store' }

type SyncContact = {
  email: string
  firstName?: string
  lastName?: string
  subscribedToNewsletter?: boolean
}

type SyncPayload = {
  apiKey?: unknown
  listId?: unknown
  contacts?: unknown
}

function isSyncContact(value: unknown): value is SyncContact {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SyncContact).email === 'string' &&
    (value as SyncContact).email.trim() !== ''
  )
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/**
 * Pushes contacts to an EmailOctopus list.
 *
 * Acts on behalf of a signed-in user, so unlike the webhook it is *not* exempt from the
 * session gate — and it verifies the session itself rather than relying on proxy.ts.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSession()

  if (!session) {
    return NextResponse.json(
      { error: 'Authentication required.' },
      { status: 401, headers: NO_STORE }
    )
  }

  try {
    const payload = (await request.json()) as SyncPayload

    const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : ''
    const listId = typeof payload?.listId === 'string' ? payload.listId.trim() : ''

    if (!apiKey || !listId || !Array.isArray(payload.contacts)) {
      return NextResponse.json(
        { error: 'Missing required sync parameters' },
        { status: 400, headers: NO_STORE }
      )
    }

    const contacts = payload.contacts.filter(isSyncContact)
    const errors: Array<{ email: string; error: string }> = []
    let syncedCount = 0

    for (const contact of contacts) {
      const status: SubscriptionStatus = contact.subscribedToNewsletter
        ? 'SUBSCRIBED'
        : 'UNSUBSCRIBED'

      try {
        await syncContactToEmailOctopus(
          apiKey,
          listId,
          contact.email,
          contact.firstName || '',
          contact.lastName || '',
          status
        )
        syncedCount += 1
      } catch (error: unknown) {
        // One bad address must not abort the whole run; collect and continue.
        console.error(`Failed to sync contact ${contact.email}:`, error)
        errors.push({ email: contact.email, error: getErrorMessage(error) })
      }
    }

    return NextResponse.json({
      success: true,
      syncedCount,
      skippedCount: payload.contacts.length - contacts.length,
      errorsCount: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    }, { headers: NO_STORE })
  } catch (error: unknown) {
    console.error('EmailOctopus Sync Error:', error)

    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500, headers: NO_STORE }
    )
  }
}

import { NextResponse, type NextRequest } from 'next/server'

import { getSession } from '@/lib/auth/dal'
import { syncContactToEmailOctopus, type SubscriptionStatus } from '@/lib/emailOctopus'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Keeps one request below typical serverless timeouts despite provider latency. */
export const SYNC_CHUNK_SIZE = 50

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
  offset?: unknown
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
 * Reads every active contact, a page at a time.
 *
 * A full sync covers the whole book, but the browser only ever holds one page of it —
 * so the list is gathered here rather than posted up from the client. Each read is
 * bounded, since an unbounded one would stop at PostgREST's 1000-row cap without
 * saying so and quietly sync a prefix of the contacts.
 */
async function fetchSyncContactChunk(offset: number): Promise<{
  contacts: SyncContact[]
  hasMore: boolean
}> {
  const db = await createSupabaseServerClient()
  const { data, error } = await db
    .from('active_contacts')
    .select('email, first_name, last_name, subscribed_to_newsletter')
    .order('created_at', { ascending: true })
    // Fetch one sentinel row beyond the chunk to prove whether more work remains.
    .range(offset, offset + SYNC_CHUNK_SIZE)

  if (error) {
    throw new Error(`Could not read contacts to sync: ${error.message}`)
  }

  const rows = data ?? []
  const contacts = rows.slice(0, SYNC_CHUNK_SIZE).flatMap((row) =>
    typeof row.email === 'string' && row.email.trim() !== ''
      ? [{
          email: row.email,
          firstName: row.first_name ?? '',
          lastName: row.last_name ?? '',
          subscribedToNewsletter: Boolean(row.subscribed_to_newsletter),
        }]
      : []
  )

  return { contacts, hasMore: rows.length > SYNC_CHUNK_SIZE }
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

    // `contacts` is optional: omitting it means "sync everything", which the server
    // reads itself. The client cannot supply the full list any more — it only holds the
    // page of contacts currently on screen.
    const syncAll = payload.contacts === undefined
    const requested = Array.isArray(payload.contacts) ? payload.contacts : []
    const offset =
      typeof payload.offset === 'number' && Number.isInteger(payload.offset) && payload.offset >= 0
        ? payload.offset
        : 0

    if (!apiKey || !listId || (!syncAll && !Array.isArray(payload.contacts))) {
      return NextResponse.json(
        { error: 'Missing required sync parameters' },
        { status: 400, headers: NO_STORE }
      )
    }

    const chunk = syncAll
      ? await fetchSyncContactChunk(offset)
      : { contacts: requested.filter(isSyncContact), hasMore: false }
    const contacts = chunk.contacts
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
      skippedCount: syncAll ? 0 : requested.length - contacts.length,
      errorsCount: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      hasMore: chunk.hasMore,
      nextOffset: chunk.hasMore ? offset + SYNC_CHUNK_SIZE : null,
    }, { headers: NO_STORE })
  } catch (error: unknown) {
    console.error('EmailOctopus Sync Error:', error)

    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500, headers: NO_STORE }
    )
  }
}

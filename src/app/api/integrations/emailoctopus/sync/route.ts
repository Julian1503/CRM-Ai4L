import { NextResponse, type NextRequest } from 'next/server'

import { getSession } from '@/lib/auth/dal'
import { loadEmailOctopusCredentials } from '@/lib/marketing/providers/credentials'
import { preferencesOrigin, providerContactFields, providerStatus } from '@/lib/contacts/providerSync'
import { syncContactToEmailOctopus } from '@/lib/emailOctopus'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Keeps one request below typical serverless timeouts despite provider latency. */
export const SYNC_CHUNK_SIZE = 50

// The error list echoes contact email addresses, so responses must not be cached.
const NO_STORE = { 'Cache-Control': 'private, no-store' }

type SyncContact = {
  /** Needed to sign the preference link. Absent for a contact posted from the client. */
  id?: string
  email: string
  firstName?: string
  lastName?: string
  subscribedToNewsletter?: boolean
  subscribedToPrograms?: boolean
}

type SyncPayload = {
  contacts?: unknown
  offset?: unknown
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
    .select('id, email, first_name, last_name, subscribed_to_newsletter, subscribed_to_programs')
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
          id: row.id,
          email: row.email,
          firstName: row.first_name ?? '',
          lastName: row.last_name ?? '',
          subscribedToNewsletter: Boolean(row.subscribed_to_newsletter),
          subscribedToPrograms: Boolean(row.subscribed_to_programs),
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
    const payload = (await request.json().catch(() => ({}))) as SyncPayload

    // Server-read only. This route used to accept a contact list from the browser, which
    // let any caller push arbitrary consent state for arbitrary addresses to the
    // provider. Single-contact changes now travel through the consent outbox (audit H5);
    // this is the full reconciliation, reading the database itself.
    if (payload.contacts !== undefined) {
      return NextResponse.json(
        { error: 'Contact lists are not accepted. Consent changes are synchronised by the server.' },
        { status: 400, headers: NO_STORE }
      )
    }
    const offset =
      typeof payload.offset === 'number' && Number.isInteger(payload.offset) && payload.offset >= 0
        ? payload.offset
        : 0

    // Read server-side only (audit H1). The browser can no longer see the key, and a
    // key it supplied would let any caller push the CRM's contacts to their own list.
    const credentials = await loadEmailOctopusCredentials()
    if (!credentials) {
      return NextResponse.json(
        { error: 'EmailOctopus is not configured. An administrator can connect it in Settings.' },
        { status: 409, headers: NO_STORE }
      )
    }
    const { apiKey, listId } = credentials

    const chunk = await fetchSyncContactChunk(offset)

    // Same resolution the booking links use, so both kinds of link in an email point at
    // the same deployment. Null when the preference link cannot be signed at all — a
    // missing secret is a deployment fault, and it must not stop the sync, only leave
    // the field out until it is fixed.
    const origin = preferencesOrigin(request.nextUrl.origin)
    const contacts = chunk.contacts
    const errors: Array<{ email: string; error: string }> = []
    let syncedCount = 0

    for (const contact of contacts) {
      const status = providerStatus(contact)

      try {
        await syncContactToEmailOctopus(
          apiKey,
          listId,
          contact.email,
          contact.firstName || '',
          contact.lastName || '',
          status,
          { fields: providerContactFields(contact, origin) }
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

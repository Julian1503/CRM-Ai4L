import { NextResponse, type NextRequest } from 'next/server'

import { getSession } from '@/lib/auth/dal'
import { syncContactToEmailOctopus, type SubscriptionStatus } from '@/lib/emailOctopus'
import {
  CONSENT_STATE_MERGE_FIELDS,
  PREFERENCES_URL_MERGE_FIELD,
} from '@/lib/marketing/mergeFields'
import { preferencesUrl } from '@/lib/preferences/token'
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

const [NEWSLETTER_FIELD, COURSES_FIELD] = CONSENT_STATE_MERGE_FIELDS

/**
 * The custom fields written with every contact.
 *
 * Two jobs the list status cannot do. `Newsletter` / `Courses` record *which* consent
 * the contact holds, so a newsletter sent from the EmailOctopus dashboard can be
 * segmented on it rather than going to everyone we are allowed to email. `PrefsUrl` is
 * their permanent preference-centre link, stored on the contact so that any template —
 * including ones this codebase never sees — can carry a working unsubscribe.
 *
 * The link is omitted rather than faked when it cannot be signed. A field holding a
 * broken URL is worse than an absent one: the absent field shows up in the setup
 * checker, the broken link only shows up as a reader who could not unsubscribe.
 */
function contactFields(contact: SyncContact, origin: string | null): Record<string, string> {
  const fields: Record<string, string> = {
    [NEWSLETTER_FIELD]: contact.subscribedToNewsletter ? 'yes' : 'no',
    [COURSES_FIELD]: contact.subscribedToPrograms ? 'yes' : 'no',
  }

  if (contact.id && origin) {
    fields[PREFERENCES_URL_MERGE_FIELD] = preferencesUrl(origin, contact.id)
  }

  return fields
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
 * Where preference links should point, or null when they cannot be signed.
 *
 * A missing PREFERENCES_SECRET is a deployment fault. It is logged once and the field
 * is skipped, rather than aborting a sync that is otherwise correct — the contacts
 * still need their consent state pushed, and the setup checker reports the gap.
 */
function readPreferencesOrigin(request: NextRequest): string | null {
  try {
    // Signing a throwaway id is the cheapest way to ask "is the secret configured"
    // without duplicating that knowledge here.
    preferencesUrl('https://example.invalid', '00000000-0000-4000-8000-000000000000')
  } catch (error) {
    console.error('Preference links are not configured, syncing without them:', error)
    return null
  }

  return process.env.NEXT_PUBLIC_APP_URL?.trim() || request.nextUrl.origin
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

    // Same resolution the booking links use, so both kinds of link in an email point at
    // the same deployment. Null when the preference link cannot be signed at all — a
    // missing secret is a deployment fault, and it must not stop the sync, only leave
    // the field out until it is fixed.
    const origin = readPreferencesOrigin(request)
    const contacts = chunk.contacts
    const errors: Array<{ email: string; error: string }> = []
    let syncedCount = 0

    for (const contact of contacts) {
      // The provider's list status is a single switch, so it answers the broader
      // question: may we email this person at all? A contact who takes courses but not
      // the newsletter must stay SUBSCRIBED here, or EmailOctopus refuses to queue the
      // course automation for them and the second consent is unusable.
      //
      // The two consents are told apart on our side, where the campaign's own stream
      // gates the audience — see segmentDefinitionToFilters.
      const status: SubscriptionStatus =
        contact.subscribedToNewsletter || contact.subscribedToPrograms
          ? 'SUBSCRIBED'
          : 'UNSUBSCRIBED'

      try {
        await syncContactToEmailOctopus(
          apiKey,
          listId,
          contact.email,
          contact.firstName || '',
          contact.lastName || '',
          status,
          { fields: contactFields(contact, origin) }
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

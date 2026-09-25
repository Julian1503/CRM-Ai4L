import { NextResponse, type NextRequest } from 'next/server'

import { MissingPreferencesSecretError, readPreferencesToken } from '@/lib/preferences/token'
import { getAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/**
 * Applies a reader's own consent choice.
 *
 * Public by design (see PUBLIC_PATHS): the person acting has no CRM account, and a
 * login wall in front of an unsubscribe is exactly what the Spam Act does not allow.
 * The signed token is the credential, and it names the only contact this route will
 * touch — there is no path here that takes an id from the request body.
 *
 * **POST only, and that is the load-bearing part of the design.** Corporate mail
 * scanners — Outlook Safe Links, Gmail's image and link proxies, antivirus gateways —
 * fetch every URL in an email before a human sees it. A GET that withdrew consent would
 * unsubscribe a chunk of the list the moment the first campaign went out, and those
 * withdrawals would be indistinguishable from real ones. So the link in the email opens
 * a page, and the page posts.
 *
 * Runs with the service-role client, like the webhook: there is no session to carry
 * row-level security. The token check above is what stands in for it.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Null means "the reader said nothing about this stream", which the RPC leaves alone. */
function readConsent(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * Request context kept with the consent change.
 *
 * This is the evidence half of the ledger. "They unsubscribed" is a claim; "they
 * unsubscribed from this address at this time with this browser" is a record that
 * answers a complaint.
 */
function readEvidence(request: NextRequest): Record<string, string> {
  const forwarded = request.headers.get('x-forwarded-for') ?? ''
  const evidence: Record<string, string> = { via: 'preference_center' }

  // The client address is the first entry; the rest are proxies.
  const ip = forwarded.split(',')[0]?.trim()
  if (ip) evidence.ip = ip

  const agent = request.headers.get('user-agent')?.trim()
  if (agent) evidence.user_agent = agent.slice(0, 300)

  return evidence
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
): Promise<NextResponse> {
  const { token } = await params

  let contactId: string | null

  try {
    contactId = readPreferencesToken(token)
  } catch (error) {
    // A missing secret is our fault, not the reader's, and must not be reported to them
    // as a broken link — they would give up on an unsubscribe that is actually fine.
    if (error instanceof MissingPreferencesSecretError) {
      console.error('Preference centre is not configured:', error.message)
      return NextResponse.json(
        { error: 'Preferences are temporarily unavailable. Please try again later.' },
        { status: 503, headers: NO_STORE }
      )
    }

    throw error
  }

  if (!contactId) {
    return NextResponse.json(
      { error: 'This link is not valid.' },
      { status: 404, headers: NO_STORE }
    )
  }

  let body: unknown

  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Expected a JSON object.' },
      { status: 400, headers: NO_STORE }
    )
  }

  const payload = (body ?? {}) as Record<string, unknown>
  const newsletter = readConsent(payload.newsletter)
  const programs = readConsent(payload.programs)

  if (newsletter === null && programs === null) {
    return NextResponse.json(
      { error: 'Choose at least one preference to change.' },
      { status: 400, headers: NO_STORE }
    )
  }

  try {
    const db = getAdminClient()

    const { error: consentError } = await db.rpc('apply_contact_consent', {
      p_contact_id: contactId,
      p_newsletter: newsletter,
      p_programs: programs,
      p_source: 'preference_center',
      p_evidence: readEvidence(request),
    })

    if (consentError) throw new Error(consentError.message)

    // Read back rather than echoing what was asked for. Withdrawing the last consent
    // archives the contact through a database trigger, so what is true afterwards is
    // not simply the request applied to the previous state.
    const { data: contact, error: readError } = await db
      .from('contacts')
      .select('subscribed_to_newsletter, subscribed_to_programs')
      .eq('id', contactId)
      .maybeSingle()

    if (readError) throw new Error(readError.message)

    return NextResponse.json(
      {
        // A token for a contact who no longer exists is answered as though the change
        // applied. Nothing useful can be done about it, and reporting it would tell a
        // stranger holding an old link whether the person is still in the database.
        newsletter: Boolean(contact?.subscribed_to_newsletter),
        programs: Boolean(contact?.subscribed_to_programs),
      },
      { headers: NO_STORE }
    )
  } catch (error) {
    console.error('Preference update failed:', error)

    return NextResponse.json(
      { error: 'Could not save your preferences. Please try again.' },
      { status: 500, headers: NO_STORE }
    )
  }
}

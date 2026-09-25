import type { Metadata } from 'next'

import { MissingPreferencesSecretError, readPreferencesToken } from '@/lib/preferences/token'
import { isSupabaseConfigured } from '@/lib/supabase/config'
import { getAdminClient } from '@/lib/supabase/admin'

import PreferencesForm, { type ConsentState } from '../PreferencesForm'
import styles from '../preferences.module.css'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your email preferences',
  // Personal to one contact, and it must never turn up in a search result.
  robots: { index: false, follow: false },
}

/**
 * The reader's email preferences.
 *
 * One optional catch-all rather than several routes, because every email carries four
 * links into the same screen and they differ only in what they pre-select:
 *
 *   /preferences/{token}             both choices, nothing pre-selected
 *   /preferences/{token}/newsletter  arriving to stop the newsletter
 *   /preferences/{token}/programs    arriving to stop course email
 *   /preferences/{token}/all         arriving to stop everything
 *
 * **Landing here changes nothing.** The per-stream links are shortcuts that pre-select
 * a change and say so; the reader still presses the button. That is not politeness — it
 * is the only safe design. Outlook Safe Links, Gmail's proxy and corporate antivirus
 * gateways open every URL in an email before a human does, so a link that acted on load
 * would unsubscribe a share of the list on the first send, indistinguishably from the
 * real ones.
 */

type Requested = 'newsletter' | 'programs' | 'all'

function readRequested(segments: string[] | undefined): Requested | undefined {
  const first = segments?.[0]

  return first === 'newsletter' || first === 'programs' || first === 'all' ? first : undefined
}

const REQUEST_LEDE: Record<Requested, string> = {
  newsletter: 'We have unticked the newsletter below. Press save to confirm it.',
  programs: 'We have unticked course and training email below. Press save to confirm it.',
  all: 'We have unticked everything below. Press save to confirm, or keep whichever you still want.',
}

export default async function PreferencesPage({
  params,
}: {
  params: Promise<{ token: string; action?: string[] }>
}) {
  const { token, action } = await params
  const requested = readRequested(action)

  let contactId: string | null = null
  let unavailable = false

  try {
    contactId = readPreferencesToken(token)
  } catch (error) {
    // Our misconfiguration, not the reader's broken link. Telling them the link is
    // invalid would make them give up on an unsubscribe that is perfectly valid.
    if (error instanceof MissingPreferencesSecretError) {
      console.error('Preference centre is not configured:', error.message)
      unavailable = true
    } else {
      throw error
    }
  }

  let consent: ConsentState | null = null

  if (contactId && isSupabaseConfigured()) {
    try {
      const { data } = await getAdminClient()
        .from('contacts')
        .select('subscribed_to_newsletter, subscribed_to_programs')
        .eq('id', contactId)
        .maybeSingle()

      if (data) {
        consent = {
          newsletter: Boolean(data.subscribed_to_newsletter),
          programs: Boolean(data.subscribed_to_programs),
        }
      }
    } catch (error) {
      console.error('Preference lookup failed:', error)
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <span className={styles.brand}>
          Ai4L<span className={styles.brandDot}>.</span>
        </span>

        {unavailable ? (
          <>
            <h1 className={styles.title}>Preferences are temporarily unavailable</h1>
            <p className={styles.lede}>
              Please try this link again shortly. If you would rather not wait, reply to
              the email you received and we will action it by hand.
            </p>
          </>
        ) : consent === null ? (
          <>
            {/* A forged token, a mistyped one and a deleted contact are answered
                identically: any difference is a way to probe who is in the database. */}
            <h1 className={styles.title}>This link is not valid</h1>
            <p className={styles.lede}>
              We could not read this preferences link. Reply to the email you received
              and we will update your preferences for you.
            </p>
          </>
        ) : (
          <>
            <h1 className={styles.title}>Your email preferences</h1>
            <p className={styles.lede}>
              {requested
                ? REQUEST_LEDE[requested]
                : 'Choose what you would like to hear about. You can change this at any time from any email we send.'}
            </p>

            <PreferencesForm token={token} initial={consent} requested={requested} />

            <p className={styles.fineprint}>
              This link is personal to you. Changes take effect immediately.
            </p>
          </>
        )}
      </div>
    </main>
  )
}

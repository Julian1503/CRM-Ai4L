import type { Metadata } from 'next'

import { loadBookingForDisplay } from '@/lib/booking/repository'
import { isSupabaseConfigured } from '@/lib/supabase/config'
import { getAdminClient } from '@/lib/supabase/admin'

import BookingStarter from './BookingStarter'
import styles from './book.module.css'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Book your consultation',
  // A booking link is personal and single-use; it should never be indexed.
  robots: { index: false, follow: false },
}

/**
 * Lead-facing booking page.
 *
 * Public: the visitor has no CRM account. The token in the URL is the credential.
 * Every failure renders the same message — distinguishing "expired" from "not found"
 * would let someone probe for valid tokens.
 */
export default async function BookingPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  let firstName = ''
  let valid = false
  let reason: string | null = null

  if (isSupabaseConfigured()) {
    try {
      const result = await loadBookingForDisplay(getAdminClient(), token)

      valid = result.usable
      reason = result.reason
      firstName = result.booking?.contact?.first_name ?? ''
    } catch (error) {
      console.error('Booking page lookup failed:', error)
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <span className={styles.brand}>
          Ai4L<span className={styles.brandDot}>.</span>
        </span>

        {valid ? (
          <>
            <h1 className={styles.title}>
              {firstName ? `${firstName}, your consultation is reserved` : 'Your consultation'}
            </h1>

            <div className={styles.priceRow}>
              <span className={styles.priceWas}>$500</span>
              <span className={styles.priceNow}>$0</span>
            </div>

            <ol className={styles.stepper} aria-label="Booking steps">
              <li className={styles.stepActive}><span>1</span> Confirm free offer</li>
              <li><span>2</span> Choose a time</li>
            </ol>

            <p className={styles.lede}>
              A 30-minute one-to-one consultation, normally $500, is yours at no cost and
              with no obligation. Confirm the $0 checkout below, then choose a time.
            </p>

            <BookingStarter token={token} />

            <p className={styles.fineprint}>
              You will not be asked for payment details. This link is personal to you and
              can be used once.
            </p>
          </>
        ) : (
          <>
            <h1 className={styles.title}>This link is no longer valid</h1>
            <p className={styles.lede}>
              {reason === 'already_used'
                ? 'This booking link has already been used. If you need to change your appointment, reply to the email you received and we will sort it out.'
                : 'This booking link has expired or is not recognised. Reply to the email you received and we will send you a new one.'}
            </p>
          </>
        )}
      </div>
    </main>
  )
}

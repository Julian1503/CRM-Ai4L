import type { Metadata } from 'next'

import { findBookingByToken } from '@/lib/booking/repository'
import { getAdminClient } from '@/lib/supabase/admin'
import { isSupabaseConfigured } from '@/lib/supabase/config'

import styles from '../book.module.css'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Choose a time',
  robots: { index: false, follow: false },
}

/**
 * Post-checkout scheduling step.
 *
 * Reached from Stripe's success_url. The Calendly scheduling link is prefilled with the
 * contact's name and email, and carries the booking id in `utm_content` so the
 * `invitee.created` webhook can attach the appointment to the right record without
 * relying on an email match.
 */
export default async function ScheduledPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const schedulingUrl = process.env.NEXT_PUBLIC_CALENDLY_SCHEDULING_URL?.trim()

  let name = ''
  let email = ''
  let bookingId = ''

  if (isSupabaseConfigured()) {
    try {
      const booking = await findBookingByToken(getAdminClient(), token)

      if (booking?.contact) {
        name = `${booking.contact.first_name} ${booking.contact.last_name}`.trim()
        email = booking.contact.email
        bookingId = booking.id
      }
    } catch (error) {
      console.error('Scheduling page lookup failed:', error)
    }
  }

  const calendlyHref = (() => {
    if (!schedulingUrl) return null

    try {
      const url = new URL(schedulingUrl)
      if (name) url.searchParams.set('name', name)
      if (email) url.searchParams.set('email', email)
      // Calendly echoes utm_* parameters back on the webhook payload under `tracking`.
      if (bookingId) url.searchParams.set('utm_content', bookingId)
      // Chrome-less embed; the surrounding page already carries the branding.
      url.searchParams.set('hide_gdpr_banner', '1')
      return url.toString()
    } catch {
      return null
    }
  })()

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <span className={styles.brand}>
          Ai4L<span className={styles.brandDot}>.</span>
        </span>

        <p className={styles.confirmed}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Confirmed — $0 charged
        </p>

        <h1 className={styles.title}>Choose a time that suits you</h1>
        <p className={styles.lede}>
          Pick any 30-minute slot below. You will get a calendar invitation straight away.
        </p>

        {calendlyHref ? (
          <iframe
            className={styles.calendlyFrame}
            src={calendlyHref}
            title="Choose a consultation time"
            loading="eager"
          />
        ) : (
          <p className={styles.error} role="alert">
            Scheduling is not configured yet. Reply to the email you received and we will
            arrange a time with you directly.
          </p>
        )}
      </div>
    </main>
  )
}

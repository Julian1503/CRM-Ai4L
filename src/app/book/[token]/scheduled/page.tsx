import type { Metadata } from 'next'
import { headers } from 'next/headers'

import { processNotifications } from '@/lib/booking/notifications'
import { applyCheckoutPayment, isCompletedCheckout } from '@/lib/booking/payment'
import { findBookingByToken } from '@/lib/booking/repository'
import { getStripeClient, getStripeConfig } from '@/lib/stripe/client'
import { getAdminClient } from '@/lib/supabase/admin'
import { isSupabaseConfigured } from '@/lib/supabase/config'

import styles from '../book.module.css'
import SchedulingStep from './SchedulingStep'

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
/**
 * The host this page is served from, for Calendly's `embed_domain`. Calendly only posts
 * its in-page events (P4.5) to an embed that names the page's domain. Null outside a
 * request, in which case the embed still works, just without those events.
 */
async function embedDomain(): Promise<string | null> {
  try {
    return (await headers()).get('host')
  } catch {
    return null
  }
}

export default async function ScheduledPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ session?: string | string[] }>
}) {
  const { token } = await params
  const query = await searchParams
  const requestedSession = Array.isArray(query.session) ? query.session[0] : query.session

  const schedulingUrl = process.env.NEXT_PUBLIC_CALENDLY_SCHEDULING_URL?.trim()
  const host = await embedDomain()

  let name = ''
  let email = ''
  let bookingId = ''
  let confirmed = false

  if (isSupabaseConfigured()) {
    try {
      const db = getAdminClient()
      const booking = await findBookingByToken(db, token)

      if (
        booking?.contact &&
        requestedSession &&
        booking.stripe_session_id === requestedSession
      ) {
        const stripeConfig = getStripeConfig()

        if (stripeConfig) {
          const stripe = getStripeClient(stripeConfig.secretKey)
          const session = await stripe.checkout.sessions.retrieve(requestedSession)

          if (isCompletedCheckout(session) && session.metadata?.booking_id === booking.id) {
            // The same operation the webhook uses, so whichever arrives first wins and
            // the other is a no-op (audit H10). It checks the checkout, the amount and
            // the currency itself, and never moves a booking backwards.
            const outcome = await applyCheckoutPayment(db, { bookingId: booking.id, session })
            confirmed = outcome === 'applied' || outcome === 'already_applied'

            if (outcome === 'applied') {
              // The confirmation email is queued with the payment; this only sends it
              // sooner. A failure leaves it for the scheduled worker.
              await processNotifications(db, {
                retrieveCheckout: (id) => stripe.checkout.sessions.retrieve(id),
                limit: 1,
              }).catch((emailError) => console.error('Confirmation email left queued:', emailError))
            }
          }
        }
      }

      if (confirmed && booking?.contact) {
        name = `${booking.contact.first_name} ${booking.contact.last_name}`.trim()
        email = booking.contact.email
        bookingId = booking.id
      }
    } catch (error) {
      console.error('Scheduling page lookup failed:', error)
    }
  }

  const calendlyHref = (() => {
    if (!confirmed || !schedulingUrl) return null

    try {
      const url = new URL(schedulingUrl)
      if (name) url.searchParams.set('name', name)
      if (email) url.searchParams.set('email', email)
      // Calendly echoes utm_* parameters back on the webhook payload under `tracking`.
      if (bookingId) url.searchParams.set('utm_content', bookingId)
      // Chrome-less embed; the surrounding page already carries the branding.
      url.searchParams.set('hide_gdpr_banner', '1')
      // Lets Calendly tell this page when the appointment is booked (display only).
      if (host) {
        url.searchParams.set('embed_domain', host)
        url.searchParams.set('embed_type', 'Inline')
      }
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

        {confirmed && (
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
        )}

        {confirmed && calendlyHref ? (
          <SchedulingStep calendlyHref={calendlyHref} email={email} />
        ) : (
          <>
            {confirmed && (
              <ol className={styles.stepper} aria-label="Booking steps">
                <li className={styles.stepDone}><span>1</span> Free offer confirmed</li>
                <li className={styles.stepActive}><span>2</span> Choose a time</li>
              </ol>
            )}

            <h1 className={styles.title}>
              {confirmed ? 'Choose a time that suits you' : 'We could not confirm your consultation'}
            </h1>

            <p className={styles.error} role="alert">
              {confirmed
                ? 'Scheduling is not configured yet. Reply to the email you received and we will arrange a time with you directly.'
                : 'Return to the original booking link and complete the $0 checkout before choosing a time.'}
            </p>
          </>
        )}
      </div>
    </main>
  )
}

import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import { getResendConfig, sendTransactionalEmail } from '@/lib/email/resend'

import { buildSchedulingLink, renderConfirmationEmail } from './confirmationEmail'
import { findBookingByToken } from './repository'

export type PaidEmailResult =
  | { status: 'sent'; emailId: string | null }
  | { status: 'skipped'; reason: 'not_configured' | 'no_link' | 'booking_mismatch' | 'no_email' }

/**
 * Emails the contact their scheduling link after checkout.
 *
 * The redirect to the scheduling page is not enough on its own: a closed tab, a flaky
 * connection or a misconfigured host leaves someone who has "paid" with no way back to
 * the calendar. This gives them a durable copy of the link.
 *
 * Throws only on a delivery failure; every "cannot or should not send" case is a skip.
 */
export async function sendBookingPaidEmail(
  db: SupabaseClient<Database>,
  session: { id: string; success_url?: string | null },
  bookingId: string
): Promise<PaidEmailResult> {
  const config = getResendConfig()
  if (!config) return { status: 'skipped', reason: 'not_configured' }

  const link = buildSchedulingLink(
    session.success_url,
    session.id,
    process.env.NEXT_PUBLIC_APP_URL
  )
  if (!link) return { status: 'skipped', reason: 'no_link' }

  // The token came from Stripe's copy of the success URL; resolving it must land on the
  // same booking the metadata names, or this link belongs to someone else.
  const booking = await findBookingByToken(db, link.token)
  if (!booking || booking.id !== bookingId) {
    return { status: 'skipped', reason: 'booking_mismatch' }
  }

  const to = booking.contact?.email?.trim()
  if (!to) return { status: 'skipped', reason: 'no_email' }

  const content = renderConfirmationEmail({
    firstName: booking.contact?.first_name,
    schedulingUrl: link.url,
  })

  const { id } = await sendTransactionalEmail(config, {
    to,
    ...content,
    idempotencyKey: `booking-paid-${bookingId}`,
  })

  return { status: 'sent', emailId: id }
}

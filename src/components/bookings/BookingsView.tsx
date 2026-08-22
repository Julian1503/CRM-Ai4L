'use client'

import React, { useCallback, useEffect, useState } from 'react'

import {
  BOOKING_STATUS_HINTS,
  BOOKING_STATUS_LABELS,
  BOOKING_STATUSES,
  type BookingStatusCounts,
  emptyBookingStatusCounts,
  formatAmountCents,
  hasSettledPayment,
} from '@/lib/booking/query'
import type { BookingStatus } from '@/lib/db/types'

import Pagination from '@/components/ui/Pagination'

import styles from './BookingsView.module.css'

type Booking = {
  id: string
  status: BookingStatus
  list_amount_cents: number
  charged_amount_cents: number | null
  currency: string
  scheduled_at: string | null
  created_at: string
  contact: { id: string; first_name: string; last_name: string; email: string } | null
  campaign: { id: string; name: string } | null
}

/** Statuses offered as filter tabs, in funnel order, plus an "all" pseudo-tab. */
const FILTER_TABS: readonly (BookingStatus | 'all')[] = ['all', ...BOOKING_STATUSES] as const

function formatDateTime(value: string | null): string {
  if (!value) return '—'

  const parsed = new Date(value)

  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

/**
 * Consultation bookings.
 *
 * The Stripe and Calendly webhooks have written booking state since Phase 5, and until
 * now nothing read it back — so "the booking and payment status is reflected in the
 * application" was true of the database and false of the application. This is the read
 * side.
 *
 * The summary strip leads with `paid`, not with `booked`. A booking sitting at `paid`
 * is a lead who accepted the free consultation and never chose a time — a follow-up the
 * client would want to make, and also the exact signature of Calendly webhooks not being
 * delivered, which is a documented risk on their plan. A screen that only celebrated
 * completed bookings would hide both.
 */
export default function BookingsView() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [counts, setCounts] = useState<BookingStatusCounts>(emptyBookingStatusCounts())
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [status, setStatus] = useState<BookingStatus | 'all'>('all')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })

      if (status !== 'all') {
        query.set('status', status)
      }

      const response = await fetch(`/api/bookings?${query.toString()}`)

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || 'Could not load bookings.')
      }

      const body = await response.json()
      setBookings(body.bookings ?? [])
      setCounts(body.counts ?? emptyBookingStatusCounts())
      setTotal(body.total ?? 0)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load bookings.')
      // An error must not leave the previous page's rows on screen looking current.
      setBookings([])
    } finally {
      setIsLoading(false)
    }
  }, [page, pageSize, status])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const awaitingTime = counts.paid

  return (
    <div className={styles.layout}>
      {error && (
        <div className={styles.error} role="alert" data-testid="bookings-error">
          {error}
        </div>
      )}

      <div className={styles.summary} data-testid="bookings-summary">
        <div className={styles.stat}>
          <span className={styles.statValue}>{counts.booked}</span>
          <span className={styles.statLabel}>Consultations booked</span>
        </div>

        <div className={`${styles.stat} ${awaitingTime > 0 ? styles.statAlert : ''}`}>
          <span className={styles.statValue}>{awaitingTime}</span>
          <span className={styles.statLabel}>Claimed, no time chosen</span>
        </div>

        <div className={styles.stat}>
          <span className={styles.statValue}>{counts.pending + counts.checkout_started}</span>
          <span className={styles.statLabel}>Links sent, not claimed</span>
        </div>

        <div className={styles.stat}>
          <span className={styles.statValue}>{counts.cancelled + counts.expired}</span>
          <span className={styles.statLabel}>Cancelled or expired</span>
        </div>
      </div>

      {awaitingTime > 0 && (
        <p className={styles.notice} data-testid="bookings-stalled-notice">
          {awaitingTime} {awaitingTime === 1 ? 'lead has' : 'leads have'} claimed the free
          consultation without picking a time. If this number keeps growing, check that
          the Calendly <code>invitee.created</code> webhook is being delivered — bookings
          stay here when it is not.
        </p>
      )}

      <div className={styles.tabs} role="tablist" aria-label="Filter bookings by status">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={status === tab}
            className={`${styles.tab} ${status === tab ? styles.tabActive : ''}`}
            onClick={() => {
              setStatus(tab)
              setPage(1)
            }}
            title={tab === 'all' ? 'Every booking' : BOOKING_STATUS_HINTS[tab]}
            data-testid={`bookings-tab-${tab}`}
          >
            {tab === 'all' ? 'All' : BOOKING_STATUS_LABELS[tab]}
            <span className={styles.tabCount}>
              {tab === 'all'
                ? Object.values(counts).reduce((sum, value) => sum + value, 0)
                : counts[tab]}
            </span>
          </button>
        ))}
      </div>

      {isLoading && <p className={styles.loading}>Loading bookings…</p>}

      {!isLoading && bookings.length === 0 && !error && (
        <p className={styles.empty} data-testid="bookings-empty">
          No bookings yet. Booking links are created when a campaign is sent — each
          recipient gets a personal one, and it appears here as soon as it is used.
        </p>
      )}

      {bookings.length > 0 && (
        <table className={styles.table} data-testid="bookings-table">
          <caption className={styles.srOnly}>
            Consultation bookings with their payment and scheduling status
          </caption>
          <thead>
            <tr>
              <th scope="col" className={styles.th}>Contact</th>
              <th scope="col" className={styles.th}>Campaign</th>
              <th scope="col" className={styles.th}>Status</th>
              <th scope="col" className={styles.th}>Value</th>
              <th scope="col" className={styles.th}>Charged</th>
              <th scope="col" className={styles.th}>Consultation</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((booking) => (
              <tr key={booking.id} className={styles.row} data-testid={`booking-${booking.id}`}>
                <td className={styles.td}>
                  {booking.contact ? (
                    <>
                      <span className={styles.name}>
                        {booking.contact.first_name} {booking.contact.last_name}
                      </span>
                      <span className={styles.sub}>{booking.contact.email}</span>
                    </>
                  ) : (
                    <span className={styles.sub}>Contact removed</span>
                  )}
                </td>

                <td className={styles.td}>{booking.campaign?.name ?? '—'}</td>

                <td className={styles.td}>
                  <span
                    className={`${styles.badge} ${styles[`badge_${booking.status}`] ?? ''}`}
                    title={BOOKING_STATUS_HINTS[booking.status]}
                  >
                    {BOOKING_STATUS_LABELS[booking.status]}
                  </span>
                </td>

                <td className={styles.td}>
                  <span className={styles.struck}>
                    {formatAmountCents(booking.list_amount_cents, booking.currency)}
                  </span>
                </td>

                <td className={styles.td}>
                  {/* An em dash, not $0, until Stripe confirms. Rendering an
                      unconfirmed booking as "$0 charged" would claim a completed
                      transaction that has not happened. */}
                  <span
                    className={hasSettledPayment(booking) ? styles.charged : styles.sub}
                    data-testid={`booking-charged-${booking.id}`}
                  >
                    {formatAmountCents(booking.charged_amount_cents, booking.currency)}
                  </span>
                </td>

                <td className={styles.td}>{formatDateTime(booking.scheduled_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        label="bookings"
        isLoading={isLoading}
        testId="bookings-pagination"
      />
    </div>
  )
}

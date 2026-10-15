'use client'

import React, { useCallback, useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'

import { NEEDS_ACTION_LABELS } from '@/lib/booking/needsAction'
import {
  BOOKING_STATUS_HINTS,
  BOOKING_STATUS_LABELS,
  BOOKING_STATUSES,
  type BookingDateField,
  type BookingQueue,
  emptyBookingStatusCounts,
  formatAmountCents,
  hasSettledPayment,
} from '@/lib/booking/query'
import type { BookingStatus } from '@/lib/db/types'

import Pagination from '@/components/ui/Pagination'

import BookingDrawer from './BookingDrawer'
import HealthLink from './HealthLink'
import {
  type BookingListResponse,
  contactName,
  formatDateTime,
  localDayToIso,
} from './shared'
import styles from './BookingsView.module.css'

type BookingsViewProps = {
  /** Opens the contact in the CRM. Without it the drawer offers the email instead. */
  onOpenContact?: (contactId: string) => void
  /** Opens integration health. Without it the link goes to Settings › Overview. */
  onOpenIntegrationHealth?: () => void
}

type Filters = {
  queue: BookingQueue
  status: BookingStatus | ''
  search: string
  dateField: BookingDateField
  fromDay: string
  toDay: string
}

const DEFAULT_FILTERS: Filters = { queue: 'needs_action', status: '', search: '', dateField: 'created', fromDay: '', toDay: '' }

export function bookingsQuery(filters: Filters, page: number, pageSize: number): string {
  const query = new URLSearchParams({ queue: filters.queue, page: String(page), pageSize: String(pageSize) })
  if (filters.status) query.set('status', filters.status)
  if (filters.search) query.set('q', filters.search)
  const from = filters.fromDay ? localDayToIso(filters.fromDay) : null
  const to = filters.toDay ? localDayToIso(filters.toDay, true) : null
  if (from || to) query.set('dateField', filters.dateField)
  if (from) query.set('from', from)
  if (to) query.set('to', to)
  return query.toString()
}

function hasNarrowing(filters: Filters): boolean {
  return Boolean(filters.status || filters.search || filters.fromDay || filters.toDay)
}

/**
 * Consultation bookings as a work queue (UX plan P4.1–P4.2).
 *
 * Opens on "Needs action": bookings a person should look at, by the rule in
 * src/lib/booking/needsAction.ts. Each row says why. Everything else is one click away
 * under "All bookings", with search, status and a date range, paged on the server.
 * A row opens a drawer with the booking's timeline and the safe actions available.
 */
export default function BookingsView({ onOpenContact, onOpenIntegrationHealth }: BookingsViewProps = {}) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [searchDraft, setSearchDraft] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [data, setData] = useState<BookingListResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const ids = useId()

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/bookings?${bookingsQuery(filters, page, pageSize)}`)
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not load bookings.')
      setData({
        bookings: body.bookings ?? [],
        counts: body.counts ?? emptyBookingStatusCounts(),
        needsActionCount: body.needsActionCount ?? 0,
        schedulingHealth: body.schedulingHealth ?? null,
        total: body.total ?? 0,
      })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load bookings.')
      // An error must not leave the previous page's rows on screen looking current.
      setData((previous) => (previous ? { ...previous, bookings: [], total: 0 } : null))
    } finally {
      setIsLoading(false)
    }
  }, [filters, page, pageSize])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const update = (patch: Partial<Filters>) => {
    setFilters((previous) => ({ ...previous, ...patch }))
    setPage(1)
  }

  const clearFilters = () => {
    setSearchDraft('')
    update({ status: '', search: '', fromDay: '', toDay: '' })
  }

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    update({ search: searchDraft.trim() })
  }

  const counts = data?.counts ?? emptyBookingStatusCounts()
  const allCount = Object.values(counts).reduce((sum, value) => sum + value, 0)
  const bookings = data?.bookings ?? []
  const health = data?.schedulingHealth

  return (
    <div className={styles.layout}>
      {error && (
        <div className={styles.error} role="alert" data-testid="bookings-error">
          {error}{' '}
          <button type="button" className={styles.linkBtn} onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      {health?.delayed && (
        <div className={styles.notice} role="status" data-testid="bookings-stalled-notice">
          <strong>Scheduling updates are delayed.</strong>{' '}
          {health.unmatchedEvents > 0 &&
            `${health.unmatchedEvents} Calendly ${health.unmatchedEvents === 1 ? 'update is' : 'updates are'} waiting to be matched. `}
          {health.failedDeliveries > 0 &&
            `${health.failedDeliveries} ${health.failedDeliveries === 1 ? 'update' : 'updates'} from Calendly failed in the last day. `}
          Bookings may show an older state until this clears.{' '}
          <HealthLink onOpen={onOpenIntegrationHealth} />
        </div>
      )}

      <p className={styles.summary} data-testid="bookings-summary">
        <span>
          <strong>{counts.booked}</strong> {BOOKING_STATUS_LABELS.booked.toLowerCase()}
        </span>
        <span>
          <strong>{counts.paid}</strong> claimed, no time chosen
        </span>
        <span>
          <strong>{counts.pending + counts.checkout_started}</strong> links not claimed yet
        </span>
        <span>
          <strong>{counts.cancelled + counts.expired}</strong> cancelled or expired
        </span>
      </p>

      <div className={styles.queueSwitch} role="group" aria-label="Which bookings to show">
        <button
          type="button"
          aria-pressed={filters.queue === 'needs_action'}
          className={filters.queue === 'needs_action' ? styles.queueActive : undefined}
          onClick={() => update({ queue: 'needs_action' })}
          data-testid="bookings-queue-needs_action"
        >
          Needs action <span className={styles.tabCount}>{data?.needsActionCount ?? 0}</span>
        </button>
        <button
          type="button"
          aria-pressed={filters.queue === 'all'}
          className={filters.queue === 'all' ? styles.queueActive : undefined}
          onClick={() => update({ queue: 'all' })}
          data-testid="bookings-queue-all"
        >
          All bookings <span className={styles.tabCount}>{allCount}</span>
        </button>
      </div>

      <div className={styles.filters}>
        <form className={styles.searchForm} role="search" onSubmit={submitSearch}>
          <label className={styles.srOnly} htmlFor={`${ids}-search`}>
            Search bookings by name or email
          </label>
          <input
            id={`${ids}-search`}
            type="search"
            className={styles.input}
            placeholder="Name or email"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
          <button type="submit" className={styles.secondaryBtn}>
            Search
          </button>
        </form>

        <label className={styles.field}>
          <span>Status</span>
          <select className={styles.input} value={filters.status} onChange={(event) => update({ status: event.target.value as BookingStatus | '' })}>
            <option value="">Any status</option>
            {BOOKING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {BOOKING_STATUS_LABELS[status]} ({counts[status]})
              </option>
            ))}
          </select>
        </label>

        <fieldset className={styles.dateRange}>
          <legend>Date range</legend>
          <select
            aria-label="Date to filter by"
            className={styles.input}
            value={filters.dateField}
            onChange={(event) => update({ dateField: event.target.value as BookingDateField })}
          >
            <option value="created">Link sent</option>
            <option value="scheduled">Consultation</option>
          </select>
          <label>
            <span className={styles.srOnly}>From</span>
            <input type="date" className={styles.input} value={filters.fromDay} max={filters.toDay || undefined} onChange={(event) => update({ fromDay: event.target.value })} />
          </label>
          <span aria-hidden="true">–</span>
          <label>
            <span className={styles.srOnly}>To</span>
            <input type="date" className={styles.input} value={filters.toDay} min={filters.fromDay || undefined} onChange={(event) => update({ toDay: event.target.value })} />
          </label>
        </fieldset>

        {hasNarrowing(filters) && (
          <button type="button" className={styles.linkBtn} onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {isLoading && <p className={styles.loading}>Loading bookings…</p>}

      {!isLoading && !error && bookings.length === 0 && (
        <EmptyState
          filters={filters}
          everEmpty={allCount === 0}
          onShowAll={() => update({ queue: 'all' })}
          onClear={clearFilters}
        />
      )}

      {bookings.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="bookings-table" aria-busy={isLoading}>
            <caption className={styles.srOnly}>Consultation bookings with their status and anything that needs action</caption>
            <thead>
              <tr>
                <th scope="col" className={styles.th}>Contact</th>
                <th scope="col" className={styles.th}>Status</th>
                <th scope="col" className={styles.th}>Needs</th>
                <th scope="col" className={styles.th}>Campaign</th>
                <th scope="col" className={styles.th}>Charged</th>
                <th scope="col" className={styles.th}>Consultation</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((booking) => (
                <tr key={booking.id} className={styles.row} data-testid={`booking-${booking.id}`}>
                  <td className={styles.td}>
                    <button type="button" className={styles.rowOpen} onClick={() => setOpenId(booking.id)} aria-label={`Open booking for ${contactName(booking.contact)}`}>
                      <span className={styles.name}>{contactName(booking.contact)}</span>
                      {booking.contact && <span className={styles.sub}>{booking.contact.email}</span>}
                    </button>
                  </td>
                  <td className={styles.td}>
                    <span className={`${styles.badge} ${styles[`badge_${booking.status}`] ?? ''}`} title={BOOKING_STATUS_HINTS[booking.status]}>
                      {BOOKING_STATUS_LABELS[booking.status]}
                    </span>
                  </td>
                  <td className={styles.td}>
                    {booking.reasons.length === 0 ? (
                      <span className={styles.sub}>—</span>
                    ) : (
                      <ul className={styles.reasonList}>
                        {booking.reasons.map((reason) => (
                          <li key={reason} className={styles.reason} title={NEEDS_ACTION_LABELS[reason].hint}>
                            {NEEDS_ACTION_LABELS[reason].label}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className={styles.td}>{booking.campaign?.name ?? '—'}</td>
                  <td className={styles.td}>
                    {/* An em dash, not $0, until Stripe confirms: "$0 charged" would claim a
                        completed transaction that has not happened. */}
                    <span className={hasSettledPayment(booking) ? styles.charged : styles.sub} data-testid={`booking-charged-${booking.id}`}>
                      {formatAmountCents(booking.charged_amount_cents, booking.currency)}
                    </span>
                    <span className={`${styles.sub} ${styles.struck}`}>{formatAmountCents(booking.list_amount_cents, booking.currency)}</span>
                  </td>
                  <td className={styles.td}>{formatDateTime(booking.scheduled_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={data?.total ?? 0}
        shown={bookings.length}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        label="bookings"
        isLoading={isLoading}
        testId="bookings-pagination"
      />

      {openId && (
        <BookingDrawer
          bookingId={openId}
          onClose={() => setOpenId(null)}
          onOpenContact={onOpenContact}
          onOpenIntegrationHealth={onOpenIntegrationHealth}
        />
      )}
    </div>
  )
}

function EmptyState({ filters, everEmpty, onShowAll, onClear }: { filters: Filters; everEmpty: boolean; onShowAll: () => void; onClear: () => void }) {
  if (hasNarrowing(filters)) {
    return (
      <p className={styles.empty} data-testid="bookings-empty">
        No bookings match these filters.{' '}
        <button type="button" className={styles.linkBtn} onClick={onClear}>
          Clear filters
        </button>
      </p>
    )
  }
  if (filters.queue === 'needs_action' && !everEmpty) {
    return (
      <p className={styles.empty} data-testid="bookings-empty">
        Nothing needs action right now.{' '}
        <button type="button" className={styles.linkBtn} onClick={onShowAll}>
          Show all bookings
        </button>
      </p>
    )
  }
  return (
    <p className={styles.empty} data-testid="bookings-empty">
      No bookings yet. Booking links are created when a campaign is sent — each recipient gets a personal one, and it appears
      here as soon as it is used.
    </p>
  )
}

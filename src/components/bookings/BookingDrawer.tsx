'use client'

import React, { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { NEEDS_ACTION_LABELS } from '@/lib/booking/needsAction'
import { BOOKING_STATUS_HINTS, BOOKING_STATUS_LABELS, formatAmountCents } from '@/lib/booking/query'
import type { BookingDetail } from '@/lib/booking/timeline'

import Portal from '@/components/ui/Portal'
import { useToast } from '@/components/ui/Toast'

import HealthLink from './HealthLink'
import { contactName, formatDateTime } from './shared'
import styles from './BookingsView.module.css'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/** Calendly's own list of scheduled events; the API URIs we store do not open in a browser. */
export const CALENDLY_EVENTS_URL = 'https://calendly.com/app/scheduled_events/user/me'

type BookingDrawerProps = {
  bookingId: string
  onClose: () => void
  onOpenContact?: (contactId: string) => void
  onOpenIntegrationHealth?: () => void
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; detail: BookingDetail }

/**
 * One booking: who, where it stands, why it needs action, its timeline, and the safe
 * actions available. Read-only — nothing here changes the booking. Resending the
 * confirmation and re-issuing a link have no server endpoint (the raw link token is
 * never stored), so they are not offered.
 */
export default function BookingDrawer({ bookingId, onClose, onOpenContact, onOpenIntegrationHealth }: BookingDrawerProps) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const { notify } = useToast()
  const headingId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let active = true
    fetch(`/api/bookings/${encodeURIComponent(bookingId)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || 'Could not load this booking.')
        if (active) setLoad({ state: 'ready', detail: body as BookingDetail })
      })
      .catch((error: unknown) => {
        if (active) setLoad({ state: 'error', message: error instanceof Error ? error.message : 'Could not load this booking.' })
      })
    return () => {
      active = false
    }
  }, [bookingId, attempt])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const trapFocus = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') return
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
    if (!focusable || focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify({ tone: 'success', message: `${what} copied.` })
    } catch {
      notify({ tone: 'error', message: `Could not copy the ${what.toLowerCase()}.` })
    }
  }

  const title = load.state === 'ready' ? contactName(load.detail.booking.contact) : 'Booking'

  return (
    <Portal>
      <div className={styles.drawerBackdrop} onClick={onClose} data-testid="booking-drawer-backdrop" />
      <aside ref={panelRef} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={trapFocus} data-testid="booking-drawer">
        <header className={styles.drawerHeader}>
          <h2 id={headingId} className={styles.drawerTitle}>
            {title}
          </h2>
          <button ref={closeRef} type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close booking details">
            ×
          </button>
        </header>

        {load.state === 'loading' && <p className={styles.loading} role="status">Loading booking…</p>}
        {load.state === 'error' && (
          <p className={styles.error} role="alert">
            {load.message}{' '}
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                setLoad({ state: 'loading' })
                setAttempt((value) => value + 1)
              }}
            >
              Try again
            </button>
          </p>
        )}
        {load.state === 'ready' && (
          <DetailBody detail={load.detail} onCopy={copy} onOpenContact={onOpenContact} onOpenIntegrationHealth={onOpenIntegrationHealth} />
        )}
      </aside>
    </Portal>
  )
}

type BodyProps = {
  detail: BookingDetail
  onCopy: (text: string, what: string) => void
  onOpenContact?: (contactId: string) => void
  onOpenIntegrationHealth?: () => void
}

function DetailBody({ detail, onCopy, onOpenContact, onOpenIntegrationHealth }: BodyProps) {
  const { booking, reasons, timeline } = detail
  const contact = booking.contact

  return (
    <div className={styles.drawerBody}>
      <p className={styles.drawerStatus}>
        <span className={`${styles.badge} ${styles[`badge_${booking.status}`] ?? ''}`}>{BOOKING_STATUS_LABELS[booking.status]}</span>
        <span className={styles.sub}>{BOOKING_STATUS_HINTS[booking.status]}</span>
      </p>

      {reasons.length > 0 && (
        <section className={styles.attention} aria-label="Needs action">
          <h3>Needs action</h3>
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>
                <strong>{NEEDS_ACTION_LABELS[reason].label}.</strong> {NEEDS_ACTION_LABELS[reason].hint}
              </li>
            ))}
          </ul>
          {reasons.includes('unmatched_calendly') && <HealthLink onOpen={onOpenIntegrationHealth} />}
        </section>
      )}

      <dl className={styles.facts}>
        <div>
          <dt>Contact</dt>
          <dd>
            {contact ? (
              <>
                {contactName(contact)} ·{' '}
                <a className={styles.link} href={`mailto:${contact.email}`}>
                  {contact.email}
                </a>
              </>
            ) : (
              'Contact removed'
            )}
          </dd>
        </div>
        <div>
          <dt>Campaign</dt>
          <dd>{booking.campaign?.name ?? '—'}</dd>
        </div>
        <div>
          <dt>Value</dt>
          <dd>
            <span className={styles.struck}>{formatAmountCents(booking.list_amount_cents, booking.currency)}</span>{' '}
            {booking.charged_amount_cents === null ? 'not claimed yet' : `${formatAmountCents(booking.charged_amount_cents, booking.currency)} charged`}
          </dd>
        </div>
        <div>
          <dt>Consultation</dt>
          <dd>{formatDateTime(booking.scheduled_at)}</dd>
        </div>
        <div>
          <dt>Link expires</dt>
          <dd>{formatDateTime(booking.expires_at)}</dd>
        </div>
      </dl>

      <section aria-label="Timeline">
        <h3 className={styles.sectionHeading}>Timeline</h3>
        <ol className={styles.timeline}>
          {timeline.map((entry) => (
            <li key={entry.key} className={styles[`tone_${entry.tone}`]}>
              <span className={styles.timelineTitle}>{entry.title}</span>
              <span className={styles.sub}>{entry.at ? formatDateTime(entry.at) : 'Time not recorded'}</span>
              {entry.detail && <span className={styles.timelineDetail}>{entry.detail}</span>}
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Actions" className={styles.drawerActions}>
        {contact && onOpenContact && (
          <button type="button" className={styles.secondaryBtn} onClick={() => onOpenContact(contact.id)}>
            Open contact
          </button>
        )}
        {contact && (
          <button type="button" className={styles.secondaryBtn} onClick={() => onCopy(contact.email, 'Email address')}>
            Copy email
          </button>
        )}
        {booking.calendly_event_uri && (
          <>
            <a className={styles.secondaryBtn} href={CALENDLY_EVENTS_URL} target="_blank" rel="noopener noreferrer">
              Open Calendly ↗
            </a>
            <button type="button" className={styles.secondaryBtn} onClick={() => onCopy(booking.calendly_event_uri as string, 'Calendly event reference')}>
              Copy Calendly event reference
            </button>
          </>
        )}
        {booking.stripe_session_id && (
          <button type="button" className={styles.secondaryBtn} onClick={() => onCopy(booking.stripe_session_id as string, 'Stripe checkout ID')}>
            Copy Stripe checkout ID
          </button>
        )}
      </section>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useRef } from 'react'

import Pagination from '@/components/ui/Pagination'

import styles from './marketing.module.css'

/**
 * Who a campaign goes to.
 *
 * Until now the audience was a number: the preview said "42 contacts" and nothing in
 * the app could name one of them. That is thin for a screen whose next button sends
 * irreversible mail — and after a send it was worse, because "3 failed" gave no way to
 * find out *who* failed without reading the database.
 */

export type Recipient = {
  contactId: string
  firstName: string
  lastName: string
  email: string
  status: 'planned' | 'pending' | 'sent' | 'failed' | 'skipped'
  error: string | null
}

export type Audience = {
  /** `ledger` is who was written to; `segment` is who would be, if sent now. */
  source: 'ledger' | 'segment'
  run: number
  segmentName: string | null
  truncated: boolean
  recipients: Recipient[]
  page: number
  pageSize: number
  total: number
}

const STATUS_LABELS: Record<Recipient['status'], string> = {
  planned: 'Will receive',
  pending: 'Queued',
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Skipped',
}

const numberFormat = new Intl.NumberFormat('en-AU')

export default function AudienceModal({
  campaignName,
  audience,
  loading,
  error,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onClose,
}: {
  campaignName: string
  audience: Audience | null
  loading: boolean
  error: string | null
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus is moved into the dialog and put back where it came from on close, so a
  // keyboard user is not returned to the top of the document.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null

    closeRef.current?.focus()

    return () => previous?.focus?.()
  }, [])

  const trapFocus = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select, [href], input, [tabindex]:not([tabindex="-1"])'
    )

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
  }, [])

  const heading = `audience-heading-${campaignName.replace(/\s+/g, '-').toLowerCase()}`

  return (
    <div
      className={styles.modalBackdrop}
      // A click on the backdrop closes; a click that started inside the dialog and
      // drifted out does not, which is why this is on the backdrop alone.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
        trapFocus(event)
      }}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        ref={dialogRef}
        data-testid="audience-modal"
      >
        <div className={styles.modalHeader}>
          <div>
            <h3 id={heading} className={styles.modalTitle}>
              {campaignName}
            </h3>
            <p className={styles.modalSubtitle}>
              {audience
                ? [
                    `${numberFormat.format(audience.total)} recipient${audience.total === 1 ? '' : 's'}`,
                    audience.segmentName,
                    audience.source === 'ledger'
                      ? `send ${audience.run}`
                      : 'not sent yet — this is who matches now',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'Loading…'}
            </p>
          </div>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={onClose}
            ref={closeRef}
            data-testid="close-audience"
          >
            Close
          </button>
        </div>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {audience?.truncated && (
          <p className={styles.constraint}>
            This segment matches more contacts than one send can carry. Only the first
            10,000 would receive it.
          </p>
        )}

        <div className={styles.modalBody}>
          <table className={styles.audienceTable}>
            <thead>
              <tr>
                <th scope="col">First name</th>
                <th scope="col">Last name</th>
                <th scope="col">Email</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {audience?.recipients.map((recipient) => (
                <tr key={recipient.contactId}>
                  <td>{recipient.firstName}</td>
                  <td>{recipient.lastName}</td>
                  <td>{recipient.email}</td>
                  <td>
                    <span
                      className={
                        recipient.status === 'failed' ? styles.recipientFailed : undefined
                      }
                    >
                      {STATUS_LABELS[recipient.status]}
                    </span>
                    {/* The provider's own words, against the contact they belong to —
                        the one place a per-recipient failure can actually be read. */}
                    {recipient.error && (
                      <span className={styles.recipientError}> — {recipient.error}</span>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && audience?.recipients.length === 0 && (
                <tr>
                  <td colSpan={4} className={styles.empty}>
                    This campaign has no audience yet. Point it at a segment first.
                  </td>
                </tr>
              )}
              {loading && !audience && (
                <tr>
                  <td colSpan={4} className={styles.empty}>
                    Loading recipients…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={audience?.total ?? 0}
          shown={audience?.recipients.length}
          isLoading={loading}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          label="recipients"
          testId="audience-pagination"
        />
      </div>
    </div>
  )
}

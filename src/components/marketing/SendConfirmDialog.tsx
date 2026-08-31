'use client'

import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import styles from './marketing.module.css'

type SendConfirmDialogProps = {
  campaignName: string
  audienceLabel: string
  audienceSize: number | null
  loading: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}

export default function SendConfirmDialog({
  campaignName,
  audienceLabel,
  audienceSize,
  loading,
  error,
  onConfirm,
  onClose,
}: SendConfirmDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const headingId = `send-confirm-${campaignName.replace(/\s+/g, '-').toLowerCase()}`

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()

    return () => previous?.focus?.()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const trapFocus = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') return

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
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
  }

  return (
    <div
      className={styles.modalBackdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget && !loading) onClose()
      }}
      onKeyDown={trapFocus}
    >
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid="send-confirm-dialog"
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id={headingId} className={styles.modalTitle}>Send campaign?</h2>
            <p className={styles.modalSubtitle}>{campaignName}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.secondaryBtn}
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </button>
        </div>

        <div className={styles.confirmBody}>
          <p>
            This action sends real email and cannot be recalled. Check the audience before
            continuing.
          </p>
          <dl className={styles.confirmSummary}>
            <div>
              <dt>Audience</dt>
              <dd>{audienceLabel}</dd>
            </div>
            <div>
              <dt>Recipients</dt>
              <dd>
                {loading ? 'Checking…' : audienceSize === null ? 'Could not verify' : audienceSize}
              </dd>
            </div>
          </dl>

          {error && <p className={styles.error} role="alert">{error}</p>}
          {!loading && audienceSize === 0 && (
            <p className={styles.error} role="alert">No subscribed contacts match this audience.</p>
          )}
        </div>

        <div className={styles.confirmActions}>
          <button type="button" className={styles.secondaryBtn} onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.dangerBtn}
            onClick={onConfirm}
            disabled={loading || audienceSize === null || audienceSize === 0 || Boolean(error)}
            data-testid="confirm-send"
          >
            {loading ? 'Checking audience…' : 'Send campaign'}
          </button>
        </div>
      </div>
    </div>
  )
}

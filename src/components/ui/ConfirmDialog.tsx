'use client'

import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'

import Portal from '@/components/ui/Portal'

import styles from './ConfirmDialog.module.css'

type ConfirmDialogProps = {
  title: string
  /** The thing being acted on, shown under the title. */
  subject?: string
  children: ReactNode
  confirmLabel: string
  busyLabel?: string
  busy?: boolean
  error?: string | null
  onConfirm: () => void
  onClose: () => void
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * A modal question with one destructive answer.
 *
 * Focus starts on Cancel, so a stray Enter backs out rather than confirming, and is
 * handed back to whatever opened the dialog when it closes. Escape closes only the
 * dialog: it is caught on `window` in the capture phase, before any drawer underneath
 * sees it — whether that drawer listens on `window` (SegmentDrawer) or on `document`
 * (ContactDrawer) — and stopped there.
 */
export default function ConfirmDialog({
  title,
  subject,
  children,
  confirmLabel,
  busyLabel,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const headingId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()

    return () => previous?.focus?.()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return

      event.stopPropagation()
      if (!busy) onClose()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [busy, onClose])

  const trapFocus = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') return

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
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
    <Portal>
      <div
        className={styles.backdrop}
        onClick={(event) => {
          // Clicks must not fall through to a drawer backdrop underneath.
          event.stopPropagation()
          if (event.target === event.currentTarget && !busy) onClose()
        }}
        onKeyDown={trapFocus}
      >
        <div
          ref={dialogRef}
          className={styles.dialog}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={headingId}
          data-testid="confirm-dialog"
        >
          <div>
            <h2 id={headingId} className={styles.title}>{title}</h2>
            {subject && <p className={styles.subject}>{subject}</p>}
          </div>

          <div className={styles.body}>{children}</div>

          {error && <p className={styles.error} role="alert">{error}</p>}

          <div className={styles.actions}>
            <button ref={cancelRef} type="button" className={styles.cancel} onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.confirm}
              onClick={onConfirm}
              disabled={busy}
              data-testid="confirm-dialog-confirm"
            >
              {busy ? (busyLabel ?? `${confirmLabel}…`) : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  )
}

'use client'

import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import Portal from '@/components/ui/Portal'

import JobTypesSettings from './JobTypesSettings'
import styles from './JobTypesDialog.module.css'

type JobTypesDialogProps = {
  onClose: () => void
  /** Called after a create or rename, so the page can refresh its job type options. */
  onChanged: () => void
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * The job type catalogue, opened on top of the contact drawer.
 *
 * A modal rather than a trip to Settings: leaving the contacts view would unmount the
 * drawer and lose the unsaved draft. Escape is caught on `window` in the capture phase
 * and stopped there, like ConfirmDialog, so it closes this and not the drawer beneath.
 */
export default function JobTypesDialog({ onClose, onChanged }: JobTypesDialogProps) {
  const headingId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()

    return () => previous?.focus?.()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

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
          // Clicks must not fall through to the drawer backdrop underneath.
          event.stopPropagation()
          if (event.target === event.currentTarget) onClose()
        }}
        onKeyDown={trapFocus}
      >
        <div
          ref={dialogRef}
          className={styles.dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          data-testid="job-types-dialog"
        >
          <div className={styles.header}>
            <h2 id={headingId} className={styles.title}>Manage job types</h2>
            <button ref={closeRef} type="button" className={styles.close} onClick={onClose}>
              Done
            </button>
          </div>
          <JobTypesSettings onChanged={onChanged} />
        </div>
      </div>
    </Portal>
  )
}

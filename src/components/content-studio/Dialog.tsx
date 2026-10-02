'use client'

import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'

import Portal from '@/components/ui/Portal'

import dialogStyles from './Dialog.module.css'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

type DialogProps = {
  title: string
  hint?: string
  children: ReactNode
  footer?: ReactNode
  /** While true, Escape and the backdrop do not close — a request is in flight. */
  busy?: boolean
  wide?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  onClose: () => void
}

/**
 * The studio's modal: focus moves in on open and back to the opener on close, Tab is
 * trapped inside, and Escape closes it (caught on window in the capture phase so a
 * drawer underneath does not also close).
 */
export default function Dialog({ title, hint, children, footer, busy = false, wide = false, initialFocusRef, onClose }: DialogProps) {
  const headingId = useId()
  const hintId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const target = initialFocusRef?.current ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? dialogRef.current
    target?.focus()
    return () => previous?.focus?.()
    // Focus is placed once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        className={dialogStyles.backdrop}
        onKeyDown={trapFocus}
        onClick={(event) => {
          event.stopPropagation()
          if (event.target === event.currentTarget && !busy) onClose()
        }}
      >
        <div
          ref={dialogRef}
          className={`${dialogStyles.dialog} ${wide ? dialogStyles.dialogWide : ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          aria-describedby={hint ? hintId : undefined}
          tabIndex={-1}
        >
          <header className={dialogStyles.dialogHeader}>
            <h2 id={headingId} className={dialogStyles.dialogTitle}>
              {title}
            </h2>
            {hint && (
              <p id={hintId} className={dialogStyles.dialogHint}>
                {hint}
              </p>
            )}
          </header>
          <div className={dialogStyles.dialogBody}>{children}</div>
          {footer && <footer className={dialogStyles.dialogFooter}>{footer}</footer>}
        </div>
      </div>
    </Portal>
  )
}

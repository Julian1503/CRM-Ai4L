'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import styles from './Toast.module.css'

/**
 * Non-blocking notices that replace `window.alert` (UX plan P0.3).
 *
 * `useToast().notify({ tone, message })` shows a notice in a polite live region, so a
 * screen reader announces it without moving focus. Success and info notices clear
 * themselves; errors stay until dismissed, because an error that vanishes before it is
 * read is an error nobody saw. Outside a <ToastProvider> `notify` is a no-op rather than
 * a crash, so a component under test does not need the provider.
 */

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastInput {
  tone: ToastTone
  message: string
}

interface ToastEntry extends ToastInput {
  id: number
}

interface ToastApi {
  notify: (toast: ToastInput) => void
}

/** How long a non-error notice stays on screen. */
export const TOAST_DURATION_MS = 6000
/** Older notices are dropped beyond this so a burst cannot cover the screen. */
export const MAX_TOASTS = 4

const ToastContext = createContext<ToastApi>({ notify: () => {} })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (toast.tone === 'error') return
    const timer = window.setTimeout(() => onDismiss(toast.id), TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [toast, onDismiss])

  return (
    <li className={`${styles.toast} ${styles[toast.tone]}`} data-testid={`toast-${toast.tone}`}>
      <span className={styles.message}>{toast.message}</span>
      <button type="button" className={styles.dismiss} onClick={() => onDismiss(toast.id)} aria-label="Dismiss notice">
        ×
      </button>
    </li>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback((toast: ToastInput) => {
    const entry = { ...toast, id: nextId.current++ }
    setToasts((current) => [...current, entry].slice(-MAX_TOASTS))
  }, [])

  const api = useMemo(() => ({ notify }), [notify])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ol className={styles.region} aria-live="polite" aria-label="Notifications">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </ol>
    </ToastContext.Provider>
  )
}

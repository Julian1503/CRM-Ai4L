'use client'

import { useState } from 'react'

import { navigateTo } from '@/lib/browser/navigate'

import styles from './book.module.css'

/**
 * Starts the Stripe Checkout redirect.
 *
 * A client component only because it needs a loading state and error surface; the
 * validity check already happened on the server before this rendered.
 */
export default function BookingStarter({ token }: { token: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setPending(true)
    setError(null)

    try {
      const response = await fetch('/api/booking/create-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })

      const body = await response.json().catch(() => ({}))

      if (!response.ok || !body.url) {
        throw new Error(body.error || 'Could not start your booking.')
      }

      navigateTo(body.url)
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Could not start your booking.')
      // Only cleared on failure — on success the page is navigating away, and
      // re-enabling the button would invite a second click mid-redirect.
      setPending(false)
    }
  }

  return (
    <div className={styles.actions}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        className={styles.cta}
        onClick={start}
        disabled={pending}
        data-testid="start-booking"
      >
        {pending ? 'One moment…' : 'Claim my free consultation'}
      </button>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'

import type { IntegrationHealth, OperationsSummary } from '@/lib/operations/types'

import styles from './OperationsPanel.module.css'

const PROVIDER_LABELS = {
  emailoctopus: 'EmailOctopus',
  stripe: 'Stripe',
  calendly: 'Calendly',
} as const

type HealthState = 'healthy' | 'attention' | 'processing' | 'quiet'

function stateFor(integration: IntegrationHealth): HealthState {
  if (integration.processingStale > 0 || integration.failed24h > 0) return 'attention'
  if (integration.processing > 0) return 'processing'
  if (!integration.lastDeliveryAt) return 'quiet'
  return 'healthy'
}

function stateLabel(state: HealthState): string {
  if (state === 'healthy') return 'Healthy'
  if (state === 'attention') return 'Needs attention'
  if (state === 'processing') return 'Processing'
  return 'No deliveries'
}

/**
 * Whether booking links can reach Stripe Checkout, read from the deployed environment.
 *
 * Separate from the delivery figures above because it is a *configuration* check rather
 * than a traffic one: a price id from the wrong Stripe mode produces no failed
 * deliveries at all — every booking link simply dies at the button, silently, on the
 * lead's screen.
 */
type StripeHealth = {
  ok: boolean
  configured: boolean
  mode: 'test' | 'live' | 'unknown'
  price: { id: string; amount: number | null; currency: string; active: boolean } | null
  coupon: { id: string; percentOff: number | null; valid: boolean } | null
  problems: string[]
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Never'

  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export default function OperationsPanel() {
  const [summary, setSummary] = useState<OperationsSummary | null>(null)
  const [stripe, setStripe] = useState<StripeHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/operations/summary', {
        cache: 'no-store',
        signal,
      })
      const body = await response.json()

      if (!response.ok || !body.summary) {
        throw new Error(body.error ?? 'Could not load operational health.')
      }

      setSummary(body.summary)
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return
      setError(loadError instanceof Error ? loadError.message : 'Could not load operational health.')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  /**
   * Read separately from the summary: it calls Stripe rather than the database, and a
   * Stripe outage must not blank the delivery figures.
   */
  const loadStripe = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/operations/stripe', { cache: 'no-store', signal })
      const body = await response.json()

      if (response.ok && typeof body?.ok === 'boolean') setStripe(body as StripeHealth)
    } catch {
      // Leaves the card absent rather than claiming a problem it did not observe.
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // The state writes happen after the network promise settles; this call only starts it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal)
    void loadStripe(controller.signal)
    return () => controller.abort()
  }, [load, loadStripe])

  const refresh = () => {
    setLoading(true)
    setError(null)
    void load()
    void loadStripe()
  }

  return (
    <section className="outerShell" aria-labelledby="operations-heading">
      <div className={`innerCore ${styles.panel}`}>
        <div className={styles.header}>
          <div>
            <h2 id="operations-heading" className={styles.title}>Operational health</h2>
            <p className={styles.subtitle}>Verified provider deliveries and conversion queues.</p>
          </div>
          <button
            type="button"
            className={styles.refreshButton}
            onClick={refresh}
            disabled={loading}
          >
            {loading ? 'Refreshing' : 'Refresh'}
          </button>
        </div>

        {loading && !summary && <div className={styles.message}>Loading operational health...</div>}

        {error && !summary && (
          <div className={`${styles.message} ${styles.error}`} role="alert">
            {error}
          </div>
        )}

        {summary && (
          <>
            {error && <div className={`${styles.inlineError} ${styles.error}`} role="alert">{error}</div>}

            <div className={styles.providers}>
              {summary.integrations.map((integration) => {
                const state = stateFor(integration)

                return (
                  <div className={styles.providerRow} key={integration.provider}>
                    <div className={styles.providerIdentity}>
                      <span className={`${styles.statusDot} ${styles[state]}`} aria-hidden="true" />
                      <div>
                        <strong>{PROVIDER_LABELS[integration.provider]}</strong>
                        <span className={styles.providerState}>{stateLabel(state)}</span>
                      </div>
                    </div>
                    <div className={styles.metric}>
                      <span>24h deliveries</span>
                      <strong>{integration.deliveries24h}</strong>
                    </div>
                    <div className={styles.metric}>
                      <span>24h events</span>
                      <strong>{integration.events24h}</strong>
                    </div>
                    <div className={styles.metric}>
                      <span>Failed</span>
                      <strong className={integration.failed24h > 0 ? styles.error : undefined}>
                        {integration.failed24h}
                      </strong>
                    </div>
                    <div className={styles.lastSeen}>
                      <span>Last success</span>
                      <strong>{formatTimestamp(integration.lastSuccessAt)}</strong>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className={styles.funnels}>
              <div className={styles.funnel}>
                <span className={styles.funnelLabel}>Campaign delivery</span>
                <strong>{summary.campaignSends.sent} sent</strong>
                <span>
                  {summary.campaignSends.pending} pending · {summary.campaignSends.failed} failed
                </span>
              </div>
              <div className={styles.funnel}>
                <span className={styles.funnelLabel}>Consultations</span>
                <strong>{summary.bookings.booked} booked</strong>
                <span>
                  {summary.bookings.paid} paid · {summary.bookings.checkoutStarted} in checkout
                </span>
              </div>
              <div className={styles.funnel}>
                <span className={styles.funnelLabel}>Contact sync</span>
                <strong>{summary.sync.events24h} events</strong>
                <span>{summary.sync.failures24h} failed in 24h</span>
              </div>
            </div>

            {stripe && !stripe.ok && (
              <div
                className={`${styles.inlineError} ${styles.error}`}
                role="alert"
                data-testid="stripe-health"
              >
                <strong>Booking links cannot start a checkout.</strong>{' '}
                {stripe.configured ? `Stripe key mode: ${stripe.mode}. ` : ''}
                {stripe.problems.join(' ')}
              </div>
            )}

            {stripe?.ok && (
              <p className={styles.updated} data-testid="stripe-health">
                Stripe ready in {stripe.mode} mode · consultation{' '}
                {stripe.price?.amount != null
                  ? `$${(stripe.price.amount / 100).toFixed(0)} ${stripe.price.currency.toUpperCase()}`
                  : 'price'}{' '}
                discounted {stripe.coupon?.percentOff ?? 0}%
              </p>
            )}

            <p className={styles.updated}>Updated {formatTimestamp(summary.generatedAt)}</p>
          </>
        )}
      </div>
    </section>
  )
}

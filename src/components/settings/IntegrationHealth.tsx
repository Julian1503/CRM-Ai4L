'use client'

import { useCallback, useEffect, useState } from 'react'

import { HEALTH_STATE_LABELS, type HealthCheckId, type HealthResult } from '@/lib/health/types'

import styles from './IntegrationHealth.module.css'

/**
 * Integration health cards (UX plan P1.5): each integration's state, what was found, when
 * it was checked, and the next thing to do. "Test connection" re-runs one check now
 * (administrators; the server refuses anyone else and the card says so).
 */

type Props = {
  /** Show only these checks, in this order (the System section shows the platform ones). */
  only?: readonly HealthCheckId[]
  title?: string
  description?: string
}

const formatTime = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' })

async function readError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return typeof body?.error === 'string' && body.error ? body.error : fallback
}

function isResult(value: unknown): value is HealthResult {
  const record = value as Partial<HealthResult> | null
  return Boolean(record && typeof record.id === 'string' && typeof record.state === 'string' && typeof record.summary === 'string')
}

export default function IntegrationHealth({
  only,
  title = 'Integration health',
  description = 'Whether each connected service works right now.',
}: Props) {
  const [checks, setChecks] = useState<HealthResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState<HealthCheckId | null>(null)
  const [cardErrors, setCardErrors] = useState<Partial<Record<HealthCheckId, string>>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/integrations/health')
      if (!response.ok) throw new Error(await readError(response, 'Could not check the integrations.'))
      const body = await response.json()
      setChecks(Array.isArray(body?.checks) ? body.checks.filter(isResult) : [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not check the integrations.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const test = async (id: HealthCheckId) => {
    setTesting(id)
    setCardErrors((current) => ({ ...current, [id]: undefined }))
    try {
      const response = await fetch(`/api/integrations/health/${id}/test`, { method: 'POST' })
      if (!response.ok) throw new Error(await readError(response, 'Could not test the connection.'))
      const body = await response.json()
      if (isResult(body?.check)) {
        setChecks((current) => (current ?? []).map((item) => (item.id === id ? body.check : item)))
      }
    } catch (testError) {
      setCardErrors((current) => ({
        ...current,
        [id]: testError instanceof Error ? testError.message : 'Could not test the connection.',
      }))
    } finally {
      setTesting(null)
    }
  }

  const shown = only
    ? only.map((id) => checks?.find((item) => item.id === id)).filter((item): item is HealthResult => Boolean(item))
    : (checks ?? [])

  return (
    <section className={styles.health} aria-labelledby="integration-health-heading" aria-busy={loading}>
      <div className={styles.healthHeader}>
        <div>
          <h3 id="integration-health-heading">{title}</h3>
          <p>{description}</p>
        </div>
        <button type="button" className={styles.refresh} onClick={() => void load()} disabled={loading}>
          {loading ? 'Checking…' : 'Check again'}
        </button>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!checks && !error && (
        <p className={styles.summary} role="status">
          Checking integrations…
        </p>
      )}

      <ul className={styles.grid}>
        {shown.map((check) => (
          <li key={check.id} className={styles.card} data-testid={`health-${check.id}`}>
            <div className={styles.cardTop}>
              <h4>{check.label}</h4>
              <span className={`${styles.badge} ${styles[check.state]}`} data-testid={`health-state-${check.id}`}>
                {HEALTH_STATE_LABELS[check.state]}
              </span>
            </div>
            <p className={styles.summary}>{check.summary}</p>
            {check.details && check.details.length > 0 && (
              <ul className={styles.details}>
                {check.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
            {check.actionHint && (
              <p className={styles.next}>
                <strong>Next step:</strong> {check.actionHint}
              </p>
            )}
            {cardErrors[check.id] && (
              <p className={styles.cardError} role="alert">
                {cardErrors[check.id]}
              </p>
            )}
            <div className={styles.meta}>
              <span>Checked {formatTime.format(new Date(check.checkedAt))}</span>
              <button
                type="button"
                className={styles.test}
                onClick={() => void test(check.id)}
                disabled={testing !== null}
                aria-label={`Test connection: ${check.label}`}
              >
                {testing === check.id ? 'Testing…' : 'Test connection'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

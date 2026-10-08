'use client'

import { useCallback, useEffect, useState } from 'react'

import styles from './marketing.module.css'

/**
 * "Send a test" for one campaign (UX plan P0.2): the current content, through its
 * EmailOctopus automation, to one address from the server's allowlist. Nothing here is
 * a delivery: the campaign's recipients, status and approval are untouched.
 */

type TestSend = {
  id: string
  revision: number
  recipient: string
  outcome: 'pending' | 'sent' | 'failed' | 'uncertain'
  error: string | null
  created_at: string
}

type TestSendState = {
  enabled: boolean
  recipients: string[]
  revision: number
  testSends: TestSend[]
  status: { lastSuccessful: TestSend | null; currentRevisionTested: boolean }
}

const OUTCOME_LABELS: Record<TestSend['outcome'], string> = {
  pending: 'Outcome unknown',
  sent: 'Accepted by EmailOctopus',
  failed: 'Failed',
  uncertain: 'Outcome unknown',
}

const when = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' })

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

/** Never trusts the response shape: a missing list is an empty one. */
function normalise(raw: unknown): TestSendState {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Partial<TestSendState>
  return {
    enabled: body.enabled === true,
    recipients: Array.isArray(body.recipients) ? body.recipients.filter((item) => typeof item === 'string') : [],
    revision: typeof body.revision === 'number' ? body.revision : 0,
    testSends: Array.isArray(body.testSends) ? body.testSends : [],
    status: {
      lastSuccessful: body.status?.lastSuccessful ?? null,
      currentRevisionTested: body.status?.currentRevisionTested === true,
    },
  }
}

type TestSendPanelProps = {
  campaignId: string
  /** The revision on screen; a test of anything else is refused. */
  revision: number
}

export default function TestSendPanel({ campaignId, revision }: TestSendPanelProps) {
  const [state, setState] = useState<TestSendState | null>(null)
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/test-send`)
      if (!response.ok) throw new Error(await readError(response))
      const body = normalise(await response.json())
      setState(body)
      setRecipient((current) => current || body.recipients[0] || '')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load test sends.')
    }
  }, [campaignId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load, revision])

  const send = async () => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/test-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient, revision }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const body = await response.json()
      if (body.testSend?.outcome !== 'sent') {
        setError(`The test was not sent: ${body.testSend?.error ?? 'EmailOctopus did not confirm it.'}`)
      }
      setNote(body.note ?? null)
      await load()
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Could not send the test.')
    } finally {
      setBusy(false)
    }
  }

  if (!state) {
    return error ? <div className={styles.error} role="alert">{error}</div> : null
  }

  const last = state.status.lastSuccessful
  const latest = state.testSends[0] ?? null

  return (
    <section className={styles.panel} aria-label="Test send" data-testid={`test-send-${campaignId}`}>
      <h3 className={styles.panelTitle}>Send a test</h3>
      {!state.enabled ? (
        <p className={styles.panelHint}>
          Test sends are not set up. An administrator adds the allowed test addresses to CAMPAIGN_TEST_RECIPIENTS.
        </p>
      ) : (
        <div className={styles.formRow}>
          <label className={styles.field}>
            <span className={styles.label}>Test recipient</span>
            <select className={styles.input} value={recipient} onChange={(event) => setRecipient(event.target.value)} data-testid="test-recipient">
              {state.recipients.map((address) => (
                <option key={address} value={address}>{address}</option>
              ))}
            </select>
            <span className={styles.fieldHint}>
              Sends this version through its EmailOctopus automation to this address only. Not counted as a send.
            </span>
          </label>
          <button type="button" className={styles.secondaryBtn} onClick={send} disabled={busy || !recipient} data-testid="send-test">
            {busy ? 'Sending test…' : 'Send a test'}
          </button>
        </div>
      )}

      {error && <div className={styles.error} role="alert">{error}</div>}
      {note && <p className={styles.panelHint} role="status">{note}</p>}

      <p className={styles.panelHint} data-testid="test-status" aria-live="polite">
        {last
          ? `Last successful test: ${last.recipient}, ${when.format(new Date(last.created_at))}, revision ${last.revision}.`
          : 'No successful test yet.'}{' '}
        {last && !state.status.currentRevisionTested && (
          <strong data-testid="test-stale">The content changed since the last test. Send a new test before approving.</strong>
        )}
        {state.status.currentRevisionTested && 'This version has been tested.'}
      </p>
      {latest && latest.outcome !== 'sent' && (
        <p className={styles.checkFailed} data-testid="test-latest-problem">
          Latest test to {latest.recipient}: {OUTCOME_LABELS[latest.outcome]}
          {latest.error ? ` — ${latest.error}` : ''}
        </p>
      )}
    </section>
  )
}

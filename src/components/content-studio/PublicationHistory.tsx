'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'

import type { SocialAccount, SocialPublication } from '@/lib/content-studio/types'

import { errorMessage, isFatalPollError, isUnavailable, listAccounts, listPublications, resolveJob } from './api'
import { useResource } from './hooks'
import { CHANNEL_LABELS, PUBLICATION_STATUS_LABELS, PUBLICATION_TONES, formatDateTime, parseHttpsUrl } from './labels'
import { StatusPill } from './StatusPill'
import styles from './ContentStudio.module.css'
import jobStyles from './Jobs.module.css'

/** How often to re-read while a publication is still queued or being sent. */
export const PUBLICATION_POLL_MS = 5000

type PublicationHistoryProps = {
  /** Limit to one item; omitted lists recent publications across items. */
  itemId?: string
  embedded?: boolean
}

async function loadAccounts(): Promise<SocialAccount[]> {
  try {
    return (await listAccounts()).accounts
  } catch {
    // Account names are a nicety here; the history is still readable without them.
    return []
  }
}

/** Publications with status, errors and links, plus the form to settle an uncertain one. */
export default function PublicationHistory({ itemId, embedded = false }: PublicationHistoryProps) {
  const loadPublications = useCallback(() => listPublications(itemId), [itemId])
  const publications = useResource(loadPublications)
  const accounts = useResource(loadAccounts)
  const [accountFilter, setAccountFilter] = useState('')
  const filterId = useId()

  // Follow publications the worker is still handling; stop once none are in flight,
  // or when polling cannot succeed (signed out, no access, feature off).
  const inFlight = (publications.data ?? []).some((row) => row.status === 'queued' || row.status === 'dispatching')
  const canPoll = inFlight && !publications.loading && !isFatalPollError(publications.error)
  const { reload } = publications
  useEffect(() => {
    if (!canPoll) return undefined
    const timer = setTimeout(reload, PUBLICATION_POLL_MS)
    return () => clearTimeout(timer)
  }, [canPoll, reload])

  const accountList = accounts.data ?? []
  const rows = (publications.data ?? []).filter((row) => !accountFilter || row.accountId === accountFilter)

  const body = (
    <>
      <div className={styles.panelHead}>
        <div>
          <h2 className={embedded ? styles.sectionTitle : styles.panelTitle}>Publications</h2>
          {!embedded && <p className={styles.panelHint}>What was sent where, and what the network answered.</p>}
        </div>
        {accountList.length > 1 && (
          <label className={styles.inlineField} htmlFor={filterId}>
            <span className={styles.label}>Account</span>
            <select id={filterId} className={styles.select} value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
              <option value="">All accounts</option>
              {accountList.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName} ({CHANNEL_LABELS[account.platform]})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {isUnavailable(publications.error) ? (
        <p className={styles.empty}>Social publishing is not available in this CRM yet.</p>
      ) : publications.error ? (
        <div className={styles.error} role="alert">
          {errorMessage(publications.error, 'Could not load publications.')}{' '}
          <button type="button" className={styles.linkBtn} onClick={publications.reload}>
            Try again
          </button>
        </div>
      ) : null}

      {publications.loading && !publications.data && <p className={styles.muted}>Loading publications…</p>}

      {publications.data && rows.length === 0 && <p className={styles.empty}>Nothing has been published yet.</p>}

      {rows.length > 0 && (
        <ul className={jobStyles.publicationList}>
          {rows.map((row) => (
            <PublicationRow key={row.id} publication={row} account={accountList.find((account) => account.id === row.accountId)} onResolved={publications.reload} />
          ))}
        </ul>
      )}
    </>
  )

  if (embedded) return <section className={styles.detailSection}>{body}</section>

  return (
    <div className="outerShell">
      <div className={`innerCore ${styles.panel}`}>{body}</div>
    </div>
  )
}

type RowProps = {
  publication: SocialPublication
  account: SocialAccount | undefined
  onResolved: () => void
}

function PublicationRow({ publication, account, onResolved }: RowProps) {
  const [resolving, setResolving] = useState(false)

  return (
    <li className={jobStyles.publicationRow} data-testid={`publication-${publication.id}`}>
      <div className={jobStyles.jobHead}>
        <StatusPill tone={PUBLICATION_TONES[publication.status]}>{PUBLICATION_STATUS_LABELS[publication.status]}</StatusPill>
        <span className={styles.itemTitle}>
          {account ? `${account.displayName} · ${CHANNEL_LABELS[account.platform]}` : 'Unknown account'}
        </span>
        <span className={styles.muted}>{formatDateTime(publication.finishedAt ?? publication.createdAt)}</span>
      </div>

      {publication.errorMessage && <p className={styles.inlineError}>{publication.errorMessage}</p>}
      {publication.resolutionNote && <p className={styles.muted}>Resolution: {publication.resolutionNote}</p>}
      {publication.permalink && (
        <a href={publication.permalink} target="_blank" rel="noopener noreferrer" className={styles.externalLink}>
          View the post ↗
        </a>
      )}

      {publication.status === 'uncertain' && (
        <div className={styles.warningNote}>
          <p>
            The network did not confirm whether this went out. Check the account, then record what you found. It will not be
            retried automatically.
          </p>
          {publication.jobId ? (
            resolving ? (
              <ResolveForm jobId={publication.jobId} onCancel={() => setResolving(false)} onResolved={onResolved} />
            ) : (
              <button type="button" className={styles.secondaryBtn} onClick={() => setResolving(true)}>
                Record the outcome
              </button>
            )
          ) : (
            <p className={styles.muted}>This publication has no job to resolve; ask an admin.</p>
          )}
        </div>
      )}
    </li>
  )
}

type ResolveFormProps = {
  jobId: string
  onCancel: () => void
  onResolved: () => void
}

export function ResolveForm({ jobId, onCancel, onResolved }: ResolveFormProps) {
  const [resolution, setResolution] = useState<'succeeded' | 'failed'>('succeeded')
  const [note, setNote] = useState('')
  const [externalId, setExternalId] = useState('')
  const [permalink, setPermalink] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!note.trim()) {
      setError('Say what you checked.')
      return
    }
    if (permalink.trim() && !parseHttpsUrl(permalink)) {
      setError('The post link must be a full https:// address.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await resolveJob(jobId, {
        resolution,
        note: note.trim(),
        externalId: resolution === 'succeeded' ? externalId.trim() || undefined : undefined,
        permalink: resolution === 'succeeded' ? permalink.trim() || undefined : undefined,
      })
      onResolved()
    } catch (resolveError) {
      setError(errorMessage(resolveError, 'Could not record the outcome.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={jobStyles.resolveForm} onSubmit={submit} aria-label="Record the outcome">
      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>What happened?</legend>
        <div className={styles.checkRow}>
          <label className={styles.check}>
            <input type="radio" name={`${id}-resolution`} checked={resolution === 'succeeded'} onChange={() => setResolution('succeeded')} />
            It was published
          </label>
          <label className={styles.check}>
            <input type="radio" name={`${id}-resolution`} checked={resolution === 'failed'} onChange={() => setResolution('failed')} />
            It was not published
          </label>
        </div>
      </fieldset>
      <label className={styles.field} htmlFor={`${id}-note`}>
        <span className={styles.label}>Note</span>
        <textarea id={`${id}-note`} className={styles.textarea} rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {resolution === 'succeeded' && (
        <div className={styles.formGrid}>
          <label className={styles.field} htmlFor={`${id}-external`}>
            <span className={styles.label}>Post ID (optional)</span>
            <input id={`${id}-external`} className={styles.input} value={externalId} onChange={(event) => setExternalId(event.target.value)} />
          </label>
          <label className={styles.field} htmlFor={`${id}-permalink`}>
            <span className={styles.label}>Post link (optional)</span>
            <input id={`${id}-permalink`} type="url" className={styles.input} value={permalink} placeholder="https://" onChange={(event) => setPermalink(event.target.value)} />
          </label>
        </div>
      )}
      {error && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.secondaryBtn} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={styles.primaryBtn} disabled={busy}>
          {busy ? 'Saving…' : 'Save outcome'}
        </button>
      </div>
    </form>
  )
}

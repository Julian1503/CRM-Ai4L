'use client'

import { useState } from 'react'

import type { ContentChannel, ContentJob } from '@/lib/content-studio/types'

import { cancelJob, errorMessage, generate } from './api'
import { useIdempotencyKey, useJobPolling } from './hooks'
import { CHANNEL_LABELS, JOB_STATUS_LABELS, JOB_TONES, formatDateTime, isTerminal } from './labels'
import { StatusPill } from './StatusPill'
import styles from './ContentStudio.module.css'
import jobStyles from './Jobs.module.css'

const MAX_SHOWN = 5

const KIND_LABELS: Partial<Record<ContentJob['kind'], string>> = {
  generate_text: 'Text generation',
  generate_image: 'Image generation',
  ingest_asset: 'Image processing',
}

/** Jobs doing the same work: same kind, and for text the same variant (null = whole item). */
function sameWork(left: ContentJob, right: ContentJob): boolean {
  return left.kind === right.kind && (left.kind !== 'generate_text' || left.variantId === right.variantId)
}

/** A finished job is superseded once a newer job does the same work; its retry would be stale. */
export function isSuperseded(job: ContentJob, jobs: ContentJob[]): boolean {
  if (!isTerminal(job.status) || job.kind === 'ingest_asset') return false
  return jobs.some((other) => other.id !== job.id && sameWork(job, other) && other.createdAt > job.createdAt)
}

/**
 * Which jobs deserve a row: every one still running, plus finished ones that need the
 * operator (failed, cancelled, uncertain, or partial failures). Newest first.
 */
export function visibleGenerationJobs(jobs: ContentJob[]): ContentJob[] {
  return jobs
    .filter((job) => job.kind in KIND_LABELS)
    .filter((job) => !isTerminal(job.status) || job.status !== 'succeeded' || job.failures.length > 0)
    .filter((job) => !isSuperseded(job, jobs))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_SHOWN)
}

/** The channels a retry should repeat: the failed ones, or all of them if the job failed outright. */
export function retryChannels(job: ContentJob, itemChannels: ContentChannel[]): ContentChannel[] {
  if (job.kind !== 'generate_text') return []
  if (job.failures.length > 0) return Array.from(new Set(job.failures.map((failure) => failure.channel)))
  return job.status === 'failed' ? itemChannels : []
}

type GenerationProgressProps = {
  itemId: string
  itemChannels: ContentChannel[]
  jobs: ContentJob[]
  /** A job ended or a new one started: the item should be reloaded. */
  onChanged: () => void
}

/**
 * Generation jobs for one item. The rows come from the item's own `jobs` list, so
 * leaving the page — or closing the browser — loses nothing: coming back re-reads the
 * list and polling resumes where it was.
 */
export default function GenerationProgress({ itemId, itemChannels, jobs, onChanged }: GenerationProgressProps) {
  const shown = visibleGenerationJobs(jobs)
  if (shown.length === 0) return null

  return (
    <section className={jobStyles.progress} aria-label="Generation progress">
      <ul className={jobStyles.jobList}>
        {shown.map((job) => (
          <GenerationJobRow key={job.id} itemId={itemId} itemChannels={itemChannels} job={job} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  )
}

type RowProps = {
  itemId: string
  itemChannels: ContentChannel[]
  job: ContentJob
  onChanged: () => void
}

function GenerationJobRow({ itemId, itemChannels, job: initial, onChanged }: RowProps) {
  const { job, stale, stopped } = useJobPolling(initial, onChanged)
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null)
  const [retried, setRetried] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Never settled: until the reload shows the new job (and hides this row as
  // superseded), any further click must reuse the same key so it cannot queue twice.
  const { keyFor } = useIdempotencyKey()

  const running = !isTerminal(job.status)
  const channels = retryChannels(job, itemChannels)

  const cancel = async () => {
    setBusy('cancel')
    setError(null)
    try {
      await cancelJob(job.id)
      onChanged()
    } catch (cancelError) {
      setError(errorMessage(cancelError, 'Could not cancel this job.'))
    } finally {
      setBusy(null)
    }
  }

  const retry = async () => {
    setBusy('retry')
    setError(null)
    try {
      const idempotencyKey = keyFor(`retry:${job.id}:${channels.join(',')}`)
      await generate(itemId, { idempotencyKey, channels })
      setRetried(true)
      onChanged()
    } catch (retryError) {
      setError(errorMessage(retryError, 'Could not start the retry.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <li className={jobStyles.jobRow} data-testid={`generation-job-${job.id}`}>
      <div className={jobStyles.jobHead}>
        <span className={jobStyles.jobLabel}>{KIND_LABELS[job.kind]}</span>
        <StatusPill tone={JOB_TONES[job.status]}>{JOB_STATUS_LABELS[job.status]}</StatusPill>
        <span className={styles.muted}>{formatDateTime(job.createdAt)}</span>
        {running && !stopped && <span className={jobStyles.spinner} aria-hidden="true" />}
        {stale && <span className={styles.muted}>Reconnecting…</span>}
        {stopped && <span className={styles.inlineError}>{stopped}</span>}
      </div>

      {running && (
        <p className={styles.muted} role="status">
          {job.cancelRequestedAt
            ? 'Cancelling — the generator stops before its next step.'
            : 'Working in the background. You can leave this page; progress is kept.'}
        </p>
      )}

      {job.status === 'uncertain' && (
        <p className={styles.warningNote} role="status">
          The generator stopped without a clear result. A person must check: reload this item and look for new
          variants before generating again, so nothing is produced twice.
        </p>
      )}

      {job.errorMessage && <p className={styles.inlineError}>{job.errorMessage}</p>}

      {job.failures.length > 0 && (
        <ul className={jobStyles.failureList} aria-label="Failed channels">
          {job.failures.map((failure) => (
            <li key={`${failure.channel}-${failure.errorCode}`}>
              <strong>{CHANNEL_LABELS[failure.channel]}:</strong> {failure.message}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className={styles.inlineError} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        {running && !job.cancelRequestedAt && (
          <button type="button" className={styles.secondaryBtn} onClick={cancel} disabled={busy !== null}>
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
        {!running && retried && (
          <span className={styles.muted} role="status">
            Retry queued.
          </span>
        )}
        {!running && !retried && channels.length > 0 && (
          <button type="button" className={styles.primaryBtn} onClick={retry} disabled={busy !== null}>
            {busy === 'retry' ? 'Retrying…' : job.failures.length > 0 ? 'Retry failed channels' : 'Retry generation'}
          </button>
        )}
        {job.status === 'uncertain' && (
          <button type="button" className={styles.secondaryBtn} onClick={onChanged}>
            Reload item
          </button>
        )}
      </div>
    </li>
  )
}

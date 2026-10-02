'use client'

import type { ContentJob } from '@/lib/content-studio/types'

import { useJobPolling } from './hooks'
import { JOB_STATUS_LABELS, JOB_TONES } from './labels'
import { StatusPill } from './StatusPill'
import styles from './ContentStudio.module.css'
import jobStyles from './Jobs.module.css'

type JobStatusLineProps = {
  job: ContentJob
  label: string
  onSettled?: (job: ContentJob) => void
}

/** One background job, followed until it ends: label, status and any error. */
export default function JobStatusLine({ job: initial, label, onSettled }: JobStatusLineProps) {
  const { job, stale, stopped } = useJobPolling(initial, onSettled)

  return (
    <li className={jobStyles.jobLine} data-testid={`job-${job.id}`}>
      <span className={jobStyles.jobLabel}>{label}</span>
      <StatusPill tone={JOB_TONES[job.status]}>{JOB_STATUS_LABELS[job.status]}</StatusPill>
      {stale && <span className={styles.muted}>Reconnecting…</span>}
      {job.errorMessage && <span className={styles.inlineError}>{job.errorMessage}</span>}
      {stopped && <span className={styles.inlineError}>{stopped}</span>}
    </li>
  )
}

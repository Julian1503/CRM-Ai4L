'use client'

import type { ConsentStream } from '@/lib/db/types'
import { CONSENT_STREAM_LABELS, parseConsentStream } from '@/lib/marketing/consentStream'

import styles from './marketing.module.css'
import StreamPill from './StreamPill'

type CampaignStreamFieldProps = {
  /** The stream of the registered template picked, when one is. */
  inherited: ConsentStream | null
  value: ConsentStream | ''
  onChange: (value: ConsentStream | '') => void
}

/**
 * Who a new campaign may reach.
 *
 * Read-only when a registered template is picked: the template is the stream, and the
 * server copies it from there regardless of what is sent. Only a hand-typed automation
 * id asks, because nothing else says who that email is for — and it is never
 * pre-selected, since a default is a guess about consent made on the operator's behalf.
 */
export default function CampaignStreamField({ inherited, value, onChange }: CampaignStreamFieldProps) {
  if (inherited) {
    return (
      <div className={styles.field}>
        <span className={styles.label}>Sends to</span>
        <span data-testid="campaign-stream-inherited">
          <StreamPill stream={inherited} />
        </span>
        <span className={styles.fieldHint}>Set by the template.</span>
      </div>
    )
  }

  return (
    <label className={styles.field}>
      <span className={styles.label}>Sends to</span>
      <select
        className={styles.input}
        value={value}
        onChange={(event) => onChange(parseConsentStream(event.target.value) ?? '')}
        data-testid="campaign-stream"
      >
        <option value="">Choose who this reaches…</option>
        {(Object.keys(CONSENT_STREAM_LABELS) as ConsentStream[]).map((option) => (
          <option key={option} value={option}>
            {CONSENT_STREAM_LABELS[option]} subscribers
          </option>
        ))}
      </select>
      <span className={styles.fieldHint}>
        Only contacts who agreed to this stream are included.
      </span>
    </label>
  )
}

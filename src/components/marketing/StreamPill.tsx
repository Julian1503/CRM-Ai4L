import type { ConsentStream } from '@/lib/db/types'
import { CONSENT_STREAM_LABELS } from '@/lib/marketing/consentStream'

import styles from './marketing.module.css'

type StreamPillProps = {
  stream: ConsentStream
  testId?: string
}

/** Which consent a template or campaign spends, shown the same way everywhere. */
export default function StreamPill({ stream, testId }: StreamPillProps) {
  return (
    <span className={`${styles.stream} ${styles[`stream_${stream}`]}`} data-testid={testId}>
      {CONSENT_STREAM_LABELS[stream]}
    </span>
  )
}

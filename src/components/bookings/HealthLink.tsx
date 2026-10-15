'use client'

import { INTEGRATION_HEALTH_HREF } from './shared'
import styles from './BookingsView.module.css'

/** "Open integration health": the page's own handler when given, otherwise Settings › Overview. */
export default function HealthLink({ onOpen }: { onOpen?: () => void }) {
  if (onOpen) {
    return (
      <button type="button" className={styles.linkBtn} onClick={onOpen}>
        Open integration health
      </button>
    )
  }
  return (
    <a className={styles.link} href={INTEGRATION_HEALTH_HREF}>
      Open integration health
    </a>
  )
}

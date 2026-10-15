import type { ReactNode } from 'react'

import styles from '@/app/page.module.css'

/** The heading block every workspace opens with: eyebrow, h1, subtitle and an action. */
export default function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow?: string
  title: string
  subtitle?: ReactNode
  action?: ReactNode
}) {
  return (
    <header className={styles.headerSection}>
      <div className={styles.titleGroup}>
        {eyebrow && (
          <div className={styles.eyebrow}>
            <span className={styles.eyebrowDot} />
            {eyebrow}
          </div>
        )}
        <h1 className={styles.pageTitle}>{title}</h1>
        {subtitle && <span className={styles.pageSubtitle}>{subtitle}</span>}
      </div>
      {action}
    </header>
  )
}

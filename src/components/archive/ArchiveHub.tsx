'use client'

import { useState } from 'react'

import ArchiveView from '@/components/contacts/ArchiveView'

import styles from './ArchiveHub.module.css'
import ArchivedRecordsList from './ArchivedRecordsList'
import { ARCHIVE_SOURCES } from './archiveSources'

type Tab = 'contacts' | keyof typeof ARCHIVE_SOURCES

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'contacts', label: 'Contacts' },
  { id: 'segments', label: 'Segments' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'templates', label: 'Templates' },
  { id: 'schedules', label: 'Schedules' },
]

/**
 * Everything archived, one tab per kind of record.
 *
 * Archived records can be restored or removed from here. Removed ones leave this view
 * too; they stay in the database, out of the application's reach.
 */
export default function ArchiveHub() {
  const [tab, setTab] = useState<Tab>('contacts')
  const source = tab === 'contacts' ? null : ARCHIVE_SOURCES[tab]

  return (
    <div className={styles.hub}>
      <nav className={styles.tabs} role="tablist" aria-label="Archived records">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`archive-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="archive-panel"
            className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
            onClick={() => setTab(item.id)}
            data-testid={`archive-tab-${item.id}`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div id="archive-panel" role="tabpanel" aria-labelledby={`archive-tab-${tab}`}>
        {source ? (
          // Keyed so switching tabs starts the list afresh on page 1.
          <ArchivedRecordsList key={tab} {...source} />
        ) : (
          <ArchiveView />
        )}
      </div>
    </div>
  )
}

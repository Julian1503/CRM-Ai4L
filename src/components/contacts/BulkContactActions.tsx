'use client'

import { MAX_SELECTED_IDS } from '@/lib/contacts/query'
import type { BulkLifecycleAction } from '@/lib/contacts/bulkLifecycle'

import styles from './BulkContactActions.module.css'

export interface BulkContactActionsProps {
  /** Contact ids currently selected (all pages). */
  selectedIds: readonly string[]
  onRequest: (action: BulkLifecycleAction) => void
  onClear: () => void
  disabled?: boolean
}

/**
 * The selection's own toolbar: stays pinned to the top of the workspace while rows are
 * ticked, so Archive and Remove are reachable however far down the list the user is.
 * Acts on the explicit ids only — an empty selection renders nothing and never means
 * "everyone".
 */
export default function BulkContactActions({ selectedIds, onRequest, onClear, disabled = false }: BulkContactActionsProps) {
  const count = selectedIds.length
  if (count === 0) return null

  const isTooLarge = count > MAX_SELECTED_IDS
  const isBlocked = disabled || isTooLarge

  return (
    <div className={styles.bar} role="toolbar" aria-label="Selected contacts" data-testid="bulk-contact-actions">
      <span className={styles.count} aria-live="polite">
        {count} {count === 1 ? 'contact' : 'contacts'} selected
        {isTooLarge && <span className={styles.limit}> — at most {MAX_SELECTED_IDS} at a time</span>}
        <span className={styles.hint} data-testid="bulk-selection-hint">
          Click rows to add or remove them, Shift-click for a range. Right-click › Open to view one.
        </span>
      </span>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={() => onRequest('archive')}
          disabled={isBlocked}
          data-testid="bulk-archive"
        >
          Archive
        </button>
        <button
          type="button"
          className={`${styles.action} ${styles.danger}`}
          onClick={() => onRequest('remove')}
          disabled={isBlocked}
          data-testid="bulk-remove"
        >
          Remove…
        </button>
        <button type="button" className={styles.clear} onClick={onClear} data-testid="bulk-clear">
          Clear selection
        </button>
      </div>
    </div>
  )
}

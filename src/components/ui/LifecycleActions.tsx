'use client'

import { useState } from 'react'

import ConfirmDialog from '@/components/ui/ConfirmDialog'
import { requestLifecycle } from '@/lib/lifecycle/client'
import type { Lifecycle, LifecycleAction } from '@/lib/lifecycle/lifecycle'

import styles from './LifecycleActions.module.css'

type LifecycleActionsProps = {
  /** The record's PATCH endpoint, e.g. `/api/segments/<id>`. */
  endpoint: string
  /** What the record is, in the operator's words: "segment", "campaign"… */
  noun: string
  name: string
  archived: boolean
  /**
   * What the rules allow, when known. A disabled button says why in its tooltip and in
   * a note under the buttons, so "why can't I archive this?" never needs guessing. When
   * absent the server still decides, and a refusal is shown the same way.
   */
  lifecycle?: Lifecycle | null
  onChanged: (action: LifecycleAction) => void | Promise<void>
  /** Prefix for test ids; defaults to the noun. */
  testId?: string
}

/**
 * Archive / Restore / Remove for one record.
 *
 * Archive and restore are reversible and act at once. Remove is not reversible from the
 * application, so it asks first — and says plainly that nothing is deleted, because
 * "remove" is a soft delete: the record's history stays in the database.
 */
export default function LifecycleActions({
  endpoint,
  noun,
  name,
  archived,
  lifecycle = null,
  onChanged,
  testId = noun,
}: LifecycleActionsProps) {
  const [busy, setBusy] = useState<LifecycleAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const run = async (action: LifecycleAction) => {
    setBusy(action)
    setError(null)

    try {
      await requestLifecycle(endpoint, action)
      setConfirming(false)
      await onChanged(action)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Could not ${action} this ${noun}.`)
    } finally {
      setBusy(null)
    }
  }

  const blocked = lifecycle?.reason ?? null
  const canArchive = lifecycle ? lifecycle.canArchive : !archived
  const canRestore = lifecycle ? lifecycle.canRestore : archived
  const canRemove = lifecycle ? lifecycle.canRemove : true

  return (
    <div className={styles.wrap}>
      <div className={styles.buttons}>
        {archived ? (
          <button
            type="button"
            className={styles.quiet}
            onClick={() => void run('restore')}
            disabled={busy !== null || !canRestore}
            title={!canRestore && blocked ? blocked : undefined}
            data-testid={`${testId}-restore`}
          >
            {busy === 'restore' ? 'Restoring…' : 'Restore'}
          </button>
        ) : (
          <button
            type="button"
            className={styles.quiet}
            onClick={() => void run('archive')}
            disabled={busy !== null || !canArchive}
            title={!canArchive && blocked ? blocked : undefined}
            data-testid={`${testId}-archive`}
          >
            {busy === 'archive' ? 'Archiving…' : 'Archive'}
          </button>
        )}
        <button
          type="button"
          className={styles.remove}
          onClick={() => {
            setError(null)
            setConfirming(true)
          }}
          disabled={busy !== null || !canRemove}
          title={!canRemove && blocked ? blocked : undefined}
          data-testid={`${testId}-remove`}
        >
          Remove
        </button>
      </div>

      {blocked && !(canArchive || canRestore) && !canRemove && (
        <p className={styles.note} data-testid={`${testId}-blocked`}>{blocked}</p>
      )}

      {error && !confirming && (
        <p className={styles.error} role="alert" data-testid={`${testId}-lifecycle-error`}>
          {error}
        </p>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Remove this ${noun}?`}
          subject={name}
          confirmLabel={`Remove ${noun}`}
          busyLabel="Removing…"
          busy={busy === 'remove'}
          error={error}
          onConfirm={() => void run('remove')}
          onClose={() => {
            setConfirming(false)
            setError(null)
          }}
        >
          <p>
            It disappears from every list in the CRM, including the archive, and cannot be
            brought back from here.
          </p>
          <p>
            Nothing is deleted: its history stays on record. To keep the option of restoring
            it, archive it instead.
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}

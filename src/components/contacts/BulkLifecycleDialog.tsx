'use client'

import { useState } from 'react'

import ConfirmDialog from '@/components/ui/ConfirmDialog'
import type { BulkLifecycleAction } from '@/lib/contacts/bulkLifecycle'

import { readErrorMessage } from './useRemoteSearch'

/** What the user asked to do, and to whom; `subject` names a single contact. */
export type BulkLifecycleRequest = {
  action: BulkLifecycleAction
  contactIds: readonly string[]
  subject?: string
}

export interface BulkLifecycleDialogProps {
  request: BulkLifecycleRequest | null
  onClose: () => void
  /** Called after the server applied the change; the page refetches and clears. */
  onDone: (result: { action: BulkLifecycleAction; updated: number; skipped: number }) => void
}

const plural = (count: number) => `${count} ${count === 1 ? 'contact' : 'contacts'}`

export function describeBulkLifecycle(action: BulkLifecycleAction, count: number, tense: 'pending' | 'done' = 'pending') {
  if (action === 'archive') return `${tense === 'done' ? 'Archived' : 'Archive'} ${plural(count)}`
  return `${tense === 'done' ? 'Removed' : 'Remove'} ${plural(count)}`
}

/**
 * Confirms, then archives or removes the chosen contacts in one all-or-nothing request.
 *
 * Archive is undone from the Archive view; remove hides the contact everywhere and only
 * an administrator can bring it back, so only remove is styled as destructive. A refusal
 * (a contact an archive rule protects) is shown in the dialog
 * and nothing changes. Contacts someone else archived meanwhile are skipped and counted.
 */
export default function BulkLifecycleDialog({ request, onClose, onDone }: BulkLifecycleDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!request) return null

  const count = request.contactIds.length
  const isRemove = request.action === 'remove'

  const close = () => {
    if (busy) return
    setError(null)
    onClose()
  }

  const confirm = async () => {
    setBusy(true)
    setError(null)

    try {
      const response = await fetch('/api/contacts/lifecycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: [...request.contactIds], action: request.action }),
      })

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `Could not ${request.action} the contacts`))
      }

      const body = (await response.json().catch(() => ({}))) as { updated?: unknown; skipped?: unknown }
      onDone({
        action: request.action,
        updated: typeof body.updated === 'number' ? body.updated : count,
        skipped: typeof body.skipped === 'number' ? body.skipped : 0,
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not ${request.action} the contacts.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      title={isRemove ? `Remove ${plural(count)}?` : `Archive ${plural(count)}?`}
      subject={request.subject}
      confirmLabel={describeBulkLifecycle(request.action, count)}
      busyLabel={isRemove ? 'Removing…' : 'Archiving…'}
      busy={busy}
      error={error}
      tone={isRemove ? 'danger' : 'neutral'}
      onConfirm={() => void confirm()}
      onClose={close}
    >
      {isRemove ? (
        <p>
          Removed contacts disappear from every list, including the Archive. Nothing is deleted —
          their sends, bookings and consent history are kept — but only an administrator can bring
          them back.
        </p>
      ) : (
        <p>
          Archived contacts leave the list and every segment. You can restore them from the Archive
          at any time.
        </p>
      )}
    </ConfirmDialog>
  )
}

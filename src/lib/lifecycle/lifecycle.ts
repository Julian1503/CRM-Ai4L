/**
 * Archive and remove, shared by every entity that has them.
 *
 * Neither destroys a row. Archived is hidden from lists and pickers and can be restored;
 * removed is hidden everywhere in the application and cannot be undone from it. Removed
 * always implies archived (a CHECK in 20260930000000_archive_and_remove.sql), so any
 * query that excludes archived rows excludes removed ones too.
 *
 * The API speaks it through PATCH: `{ archived: boolean }` or `{ removed: true }`, on
 * its own, never mixed with an edit.
 */

export type LifecycleAction = 'archive' | 'restore' | 'remove'

export type LifecycleRequest =
  | { kind: 'none' }
  | { kind: LifecycleAction }
  | { kind: 'invalid'; error: string }

/** What the UI may offer for one record, and why not when it may not. */
export type Lifecycle = {
  canArchive: boolean
  canRestore: boolean
  canRemove: boolean
  reason: string | null
}

export type LifecycleState = { archived_at: string | null; removed_at?: string | null }

/** SQLSTATE raised by every archive rule in the database. */
export const ARCHIVE_RULE_SQLSTATE = 'CRM01'

export function readLifecycleAction(body: Record<string, unknown>): LifecycleRequest {
  const hasArchived = body.archived !== undefined
  const hasRemoved = body.removed !== undefined

  if (!hasArchived && !hasRemoved) return { kind: 'none' }

  if (Object.keys(body).length > 1) {
    return { kind: 'invalid', error: 'Archive or remove on its own, not together with other changes.' }
  }

  if (hasRemoved) {
    return body.removed === true
      ? { kind: 'remove' }
      : { kind: 'invalid', error: 'A removal cannot be undone.' }
  }

  if (typeof body.archived !== 'boolean') {
    return { kind: 'invalid', error: '`archived` must be true or false.' }
  }

  return { kind: body.archived ? 'archive' : 'restore' }
}

/** The columns to write for an action. The caller has already checked it is allowed. */
export function lifecyclePatch(
  action: LifecycleAction,
  current: LifecycleState,
  userId: string,
  now: string = new Date().toISOString()
): { archived_at: string | null; removed_at?: string; removed_by?: string } {
  if (action === 'archive') return { archived_at: now }
  if (action === 'restore') return { archived_at: null }

  return { archived_at: current.archived_at ?? now, removed_at: now, removed_by: userId }
}

/** Whether an action is allowed by a computed lifecycle; the refusal reason if not. */
export function refusal(action: LifecycleAction, lifecycle: Lifecycle): string | null {
  const allowed = {
    archive: lifecycle.canArchive,
    restore: lifecycle.canRestore,
    remove: lifecycle.canRemove,
  }[action]

  if (allowed) return null

  return lifecycle.reason ?? `This cannot be ${action === 'remove' ? 'removed' : `${action}d`} right now.`
}

/** True for a database archive-rule refusal, so a race still answers 409, not 500. */
export function isArchiveRuleError(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === ARCHIVE_RULE_SQLSTATE
}

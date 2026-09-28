import type { LifecycleAction } from './lifecycle'

/**
 * Browser side of archive / restore / remove: one PATCH per action, the same body
 * shape for every entity (see `readLifecycleAction`).
 */

const BODIES: Record<LifecycleAction, { archived?: boolean; removed?: true }> = {
  archive: { archived: true },
  restore: { archived: false },
  remove: { removed: true },
}

/** Sends the action. Resolves on success; rejects with the API's own explanation. */
export async function requestLifecycle(endpoint: string, action: LifecycleAction): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(BODIES[action]),
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `Request failed (HTTP ${response.status})`)
  }
}

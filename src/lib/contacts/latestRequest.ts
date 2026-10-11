/**
 * "Only the newest request may answer" (audit M1).
 *
 * Each begin() aborts the previous request and returns a ticket. A response whose ticket
 * is no longer current is dropped by the caller, so a slow old search can never overwrite
 * the results of a newer one, even if the server ignores the abort.
 */
export type RequestTicket = { signal: AbortSignal; isCurrent: () => boolean }

export type LatestRequest = { begin: () => RequestTicket; cancel: () => void }

export function createLatestRequest(): LatestRequest {
  let current: AbortController | null = null
  let sequence = 0

  return {
    begin() {
      current?.abort()
      const controller = new AbortController()
      const id = ++sequence
      current = controller
      return { signal: controller.signal, isCurrent: () => id === sequence && !controller.signal.aborted }
    },
    cancel() {
      current?.abort()
      current = null
      sequence += 1
    },
  }
}

/** True for the error fetch rejects with when its signal aborts. */
export function isAbortError(error: unknown): boolean {
  return (error instanceof Error || (typeof error === 'object' && error !== null)) && (error as { name?: string }).name === 'AbortError'
}

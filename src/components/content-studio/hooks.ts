'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ContentJob } from '@/lib/content-studio/types'

import { ApiError, getJob, isFatalPollError } from './api'
import { isTerminal } from './labels'

/** A fresh idempotency key. The server dedupes on it, so one user action = one key. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * Keys that survive a retry of the same click.
 *
 * `keyFor(fingerprint)` returns the key already issued for that fingerprint until the
 * action is `settle()`d, so a network failure retried with the same input can never
 * create a second job or revision. Changing the input (a new fingerprint) is a new
 * action and gets a new key.
 */
export function useIdempotencyKey() {
  const current = useRef<{ fingerprint: string; key: string } | null>(null)

  const keyFor = useCallback((fingerprint: string) => {
    if (current.current?.fingerprint === fingerprint) return current.current.key
    const key = newIdempotencyKey()
    current.current = { fingerprint, key }
    return key
  }, [])

  const settle = useCallback(() => {
    current.current = null
  }, [])

  // Stable identity, so it can sit in a dependency list without re-running effects.
  return useMemo(() => ({ keyFor, settle }), [keyFor, settle])
}

export type Resource<T> = {
  data: T | null
  error: unknown
  loading: boolean
  reload: () => void
}

type Settled<T> = {
  version: number
  source: unknown
  data: T | null
  error: unknown
}

/**
 * Loads `load()` and reloads when its identity changes or `reload()` is called.
 *
 * State is only set from the promise callbacks, never synchronously inside the effect.
 * A load superseded by a reload or a new loader is discarded (its effect was cleaned
 * up), so a slow earlier request can never overwrite newer data.
 *
 * Data and errors belong to the loader that produced them: when the loader changes
 * (another account, another search) the old result is not shown as the new one's,
 * unless `keepPrevious` asks for it while the new one loads — and never after the new
 * one fails.
 */
export function useResource<T>(load: () => Promise<T>, { keepPrevious = false }: { keepPrevious?: boolean } = {}): Resource<T> {
  const [version, setVersion] = useState(0)
  const [settled, setSettled] = useState<Settled<T>>({ version: -1, source: null, data: null, error: null })

  useEffect(() => {
    let active = true
    load().then(
      (data) => {
        if (active) setSettled({ version, source: load, data, error: null })
      },
      (error: unknown) => {
        if (active) setSettled((previous) => ({ version, source: load, data: previous.source === load ? previous.data : null, error }))
      }
    )
    return () => {
      active = false
    }
  }, [load, version])

  const reload = useCallback(() => setVersion((value) => value + 1), [])
  const current = settled.source === load

  return {
    data: current || keepPrevious ? settled.data : null,
    error: current ? settled.error : null,
    loading: settled.version !== version || !current,
    reload,
  }
}

function stopReason(error: unknown): string {
  if (error instanceof ApiError && error.code === 'feature_disabled') return 'Stopped following this job: the feature is switched off.'
  if (error instanceof ApiError && error.status === 404) return 'Stopped following this job: it no longer exists.'
  return 'Stopped following this job: you no longer have access. Sign in again and reload.'
}

export const POLL_INITIAL_MS = 1000
export const POLL_MAX_MS = 15000
const POLL_GROWTH = 1.6

export function nextPollDelay(previous: number): number {
  return Math.min(Math.round(previous * POLL_GROWTH), POLL_MAX_MS)
}

export type PolledJob = {
  job: ContentJob
  /** The last poll failed; the shown status may be out of date. */
  stale: boolean
  /** Polling gave up for good (no access, job gone, feature off); why, for the operator. */
  stopped: string | null
}

/**
 * Follows a job until it reaches a terminal state, backing off between polls.
 *
 * Driven entirely by the job id it is given, so a remount — or closing the browser and
 * coming back to an item whose `jobs` list still has the job — simply resumes.
 * `onSettled` fires once, when a poll first sees the job terminal.
 */
export function useJobPolling(initial: ContentJob, onSettled?: (job: ContentJob) => void): PolledJob {
  const [state, setState] = useState<PolledJob>({ job: initial, stale: false, stopped: null })
  const settledRef = useRef(onSettled)

  useEffect(() => {
    settledRef.current = onSettled
  }, [onSettled])

  const jobId = initial.id
  const startsTerminal = isTerminal(initial.status)

  useEffect(() => {
    if (startsTerminal) return undefined

    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let delay = POLL_INITIAL_MS

    const poll = async () => {
      try {
        const job = await getJob(jobId)
        if (!active) return
        setState({ job, stale: false, stopped: null })
        if (isTerminal(job.status)) {
          settledRef.current?.(job)
          return
        }
      } catch (error) {
        if (!active) return
        if (isFatalPollError(error)) {
          setState((previous) => ({ ...previous, stale: false, stopped: stopReason(error) }))
          return
        }
        setState((previous) => ({ ...previous, stale: true }))
      }
      delay = nextPollDelay(delay)
      timer = setTimeout(poll, delay)
    }

    timer = setTimeout(poll, delay)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [jobId, startsTerminal])

  // The parent may learn of the end first (it reloaded the item after a cancel); a
  // terminal status from either side wins over a stale in-flight one.
  if (startsTerminal && !isTerminal(state.job.status)) return { job: initial, stale: false, stopped: null }
  return state
}

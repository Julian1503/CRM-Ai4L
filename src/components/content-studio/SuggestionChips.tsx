'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { ApiError, errorMessage } from './api'
import styles from './Suggestions.module.css'

export type Suggestion = {
  key: string
  /** What the chip shows. */
  label: string
  /** A second, quieter line (an image prompt under its short label). */
  detail?: string
  /** What picking it puts in the field. */
  value: string
}

export type SuggestionChipsProps = {
  title: string
  /** `fresh` asks for suggestions different from the ones already shown. */
  load: (fresh: boolean) => Promise<Suggestion[]>
  onPick: (value: string) => void
  /** Load as soon as the chips are shown (a dialog opened for this), or wait for a click. */
  autoLoad?: boolean
  /** The button that starts an on-demand load. */
  startLabel?: string
}

type State =
  | { status: 'idle' }
  | { status: 'loading'; previous: Suggestion[] }
  | { status: 'ready'; suggestions: Suggestion[] }
  | { status: 'error'; message: string }

function failureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return 'Too many suggestions in a minute. Wait a moment and try again.'
  return errorMessage(error, 'Suggestions are unavailable right now.')
}

/**
 * AI suggestions for one field (docs/CONTENT_STUDIO_SUGGESTIONS_PLAN.md). A chip only
 * fills the field — the person edits or ignores it — and a failure stays quiet: the form
 * works the same without suggestions.
 */
export default function SuggestionChips({ title, load, onPick, autoLoad = false, startLabel = 'Suggest' }: SuggestionChipsProps) {
  const [state, setState] = useState<State>(() => (autoLoad ? { status: 'loading', previous: [] } : { status: 'idle' }))
  const [picked, setPicked] = useState<string | null>(null)
  const latest = useRef(0)
  // Read through a ref so a parent that passes a new function each render does not reload.
  const loadRef = useRef(load)
  const titleId = useId()

  useEffect(() => {
    loadRef.current = load
  }, [load])

  /** Settles request number `request`, unless a newer one was started meanwhile. */
  const fetchSuggestions = useCallback(async (fresh: boolean, request: number) => {
    try {
      const suggestions = await loadRef.current(fresh)
      if (request === latest.current) setState({ status: 'ready', suggestions })
    } catch (error) {
      if (request === latest.current) setState({ status: 'error', message: failureMessage(error) })
    }
  }, [])

  const run = (fresh: boolean) => {
    const request = ++latest.current
    setState((current) => ({ status: 'loading', previous: current.status === 'ready' ? current.suggestions : [] }))
    void fetchSuggestions(fresh, request)
  }

  useEffect(() => {
    if (!autoLoad) return
    void fetchSuggestions(false, ++latest.current)
    return () => {
      // An answer arriving after unmount is dropped.
      latest.current += 1
    }
  }, [autoLoad, fetchSuggestions])

  const pick = (suggestion: Suggestion) => {
    setPicked(suggestion.key)
    onPick(suggestion.value)
  }

  const loading = state.status === 'loading'
  const shown = state.status === 'ready' ? state.suggestions : state.status === 'loading' ? state.previous : []

  return (
    <section className={styles.suggestions} aria-labelledby={titleId} aria-busy={loading}>
      <div className={styles.head}>
        <span id={titleId} className={styles.title}>
          <span className={styles.spark} aria-hidden="true" />
          {title}
        </span>
        {state.status === 'idle' && (
          <button type="button" className={styles.action} onClick={() => run(false)}>
            {startLabel}
          </button>
        )}
        {(state.status === 'ready' || (loading && shown.length > 0)) && (
          <button type="button" className={styles.action} onClick={() => run(true)} disabled={loading}>
            {loading ? 'Thinking…' : 'More ideas'}
          </button>
        )}
      </div>

      {loading && shown.length === 0 && (
        <div className={styles.chips} role="status">
          <span className={styles.visuallyHidden}>Loading suggestions…</span>
          {[0, 1, 2].map((index) => (
            <span key={index} className={styles.skeleton} aria-hidden="true" />
          ))}
        </div>
      )}

      {shown.length > 0 && (
        <ul className={`${styles.chips} ${loading ? styles.stale : ''}`}>
          {shown.map((suggestion) => (
            <li key={suggestion.key}>
              <button
                type="button"
                className={styles.chip}
                aria-pressed={picked === suggestion.key}
                disabled={loading}
                onClick={() => pick(suggestion)}
                title={suggestion.detail}
              >
                <span className={styles.chipLabel}>{suggestion.label}</span>
                {suggestion.detail && <span className={styles.chipDetail}>{suggestion.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {state.status === 'ready' && state.suggestions.length === 0 && <p className={styles.note}>No suggestions this time.</p>}

      {state.status === 'error' && (
        <p className={styles.note} role="status">
          {state.message}{' '}
          <button type="button" className={styles.action} onClick={() => run(false)}>
            Try again
          </button>
        </p>
      )}
    </section>
  )
}

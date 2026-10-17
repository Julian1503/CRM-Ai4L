'use client'

import { useId, useRef, useState } from 'react'

import type { BriefCompletion, BriefDraftFields } from '@/lib/content-studio/suggestionTypes'
import type { ApprovedFact, ContentChannel } from '@/lib/content-studio/types'

import { ApiError, errorMessage, suggest } from './api'
import { CHANNEL_LABELS } from './labels'
import styles from './Suggestions.module.css'

export type BriefField = keyof BriefDraftFields

const FIELDS: { key: BriefField; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'audience', label: 'Audience' },
  { key: 'objective', label: 'Objective' },
  { key: 'notes', label: 'Notes' },
]

type BriefAssistProps = {
  topic: string
  /** What the member has typed so far; the completion keeps its intent. */
  values: Record<BriefField, string>
  sourceFacts: string[]
  channels: ContentChannel[]
  /** The brand's approved facts, to show the suggested ids as text. */
  approvedFacts: ApprovedFact[]
  onUse: (field: BriefField, value: string) => void
  onAddFact: (text: string) => void
  onChannels: (channels: ContentChannel[]) => void
}

type State =
  | { status: 'idle' }
  | { status: 'loading'; previous: BriefCompletion | null }
  | { status: 'ready'; completion: BriefCompletion }
  | { status: 'error'; message: string }

function failureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return 'Too many suggestions in a minute. Wait a moment and try again.'
  return errorMessage(error, 'Suggestions are unavailable right now.')
}

const same = (left: string, right: string) => left.trim() === right.trim()

/**
 * "Complete with AI" for the brief (docs/CONTENT_STUDIO_SUGGESTIONS_PLAN.md, F2). Each
 * suggested value waits for its own click, and a field the member already wrote says
 * "Replace" rather than "Use", so nothing typed is ever overwritten silently.
 */
export default function BriefAssist({ topic, values, sourceFacts, channels, approvedFacts, onUse, onAddFact, onChannels }: BriefAssistProps) {
  const [state, setState] = useState<State>({ status: 'idle' })
  const latest = useRef(0)
  const titleId = useId()
  const hasTopic = topic.trim().length > 0

  const run = async (fresh: boolean) => {
    const request = ++latest.current
    setState((current) => ({ status: 'loading', previous: current.status === 'ready' ? current.completion : null }))
    const draft = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())) as BriefDraftFields
    try {
      const { completion } = await suggest({ kind: 'brief_completion', topic: topic.trim(), draft, fresh })
      if (request === latest.current) setState({ status: 'ready', completion })
    } catch (error) {
      if (request === latest.current) setState({ status: 'error', message: failureMessage(error) })
    }
  }

  const loading = state.status === 'loading'
  const completion = state.status === 'ready' ? state.completion : state.status === 'loading' ? state.previous : null
  const suggested = completion ? FIELDS.filter(({ key }) => completion[key]) : []
  const emptyToFill = suggested.filter(({ key }) => !values[key].trim())
  const factTexts = new Map(approvedFacts.map((fact) => [fact.id, fact.text]))
  const facts = (completion?.factIds ?? []).map((id) => factTexts.get(id)).filter((text): text is string => Boolean(text))
  const channelsDiffer = Boolean(completion?.channels.length) && completion!.channels.join() !== channels.join()

  const fillEmpty = () => emptyToFill.forEach(({ key }) => onUse(key, completion![key] as string))

  return (
    <section className={`${styles.suggestions} ${styles.assist}`} aria-labelledby={titleId} aria-busy={loading}>
      <div className={styles.head}>
        <span id={titleId} className={styles.title}>
          <span className={styles.spark} aria-hidden="true" />
          AI assist
        </span>
        {completion ? (
          <button type="button" className={styles.action} onClick={() => void run(true)} disabled={loading || !hasTopic}>
            {loading ? 'Thinking…' : 'More ideas'}
          </button>
        ) : (
          <button type="button" className={styles.action} onClick={() => void run(false)} disabled={loading || !hasTopic}>
            {loading ? 'Thinking…' : 'Complete with AI'}
          </button>
        )}
      </div>

      {state.status === 'idle' && (
        <p className={styles.note}>
          {hasTopic ? 'Suggests a title, audience, objective, notes and channels from your topic.' : 'Write a topic first.'}
        </p>
      )}
      {loading && !completion && (
        <p className={styles.note} role="status">
          Reading your topic…
        </p>
      )}
      {state.status === 'error' && (
        <p className={styles.note} role="status">
          {state.message}{' '}
          <button type="button" className={styles.action} onClick={() => void run(false)}>
            Try again
          </button>
        </p>
      )}

      {completion && (
        <ul className={`${styles.assistRows} ${loading ? styles.stale : ''}`}>
          {suggested.map(({ key, label }) => {
            const value = completion[key] as string
            const current = values[key]
            return (
              <li key={key} className={styles.assistRow}>
                <span className={styles.assistLabel}>{label}</span>
                <span className={styles.assistValue}>{value}</span>
                {same(current, value) ? (
                  <span className={styles.assistDone}>In use</span>
                ) : (
                  <button type="button" className={styles.action} disabled={loading} onClick={() => onUse(key, value)} aria-label={`${current.trim() ? 'Replace' : 'Use'} ${label.toLowerCase()}: ${value}`}>
                    {current.trim() ? 'Replace' : 'Use'}
                  </button>
                )}
              </li>
            )
          })}
          {channelsDiffer && (
            <li className={styles.assistRow}>
              <span className={styles.assistLabel}>Channels</span>
              <span className={styles.assistValue}>{completion.channels.map((channel) => CHANNEL_LABELS[channel]).join(', ')}</span>
              <button type="button" className={styles.action} disabled={loading} onClick={() => onChannels(completion.channels)} aria-label="Use the suggested channels">
                Use
              </button>
            </li>
          )}
          {facts.map((text) => {
            const added = sourceFacts.some((fact) => same(fact, text))
            return (
              <li key={text} className={styles.assistRow}>
                <span className={styles.assistLabel}>Fact</span>
                <span className={styles.assistValue}>{text}</span>
                {added ? (
                  <span className={styles.assistDone}>Added</span>
                ) : (
                  <button type="button" className={styles.action} disabled={loading} onClick={() => onAddFact(text)} aria-label={`Add fact: ${text}`}>
                    Add
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {completion && emptyToFill.length > 1 && (
        <button type="button" className={styles.fillAll} disabled={loading} onClick={fillEmpty}>
          Fill the {emptyToFill.length} empty fields
        </button>
      )}
    </section>
  )
}

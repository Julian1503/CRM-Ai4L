'use client'

import React, { useState } from 'react'

import styles from './preferences.module.css'

export type ConsentState = { newsletter: boolean; programs: boolean }

type Props = {
  token: string
  initial: ConsentState
  /**
   * The stream a per-stream link named, if any.
   *
   * Every email carries one link per consent as well as one to this page, so a reader
   * who only wants to stop the course emails does not have to read a settings screen to
   * do it. Arriving that way pre-selects the change and states it plainly; the choices
   * stay editable, because the link is a shortcut and not a decision already made.
   */
  requested?: 'newsletter' | 'programs' | 'all'
}

const COPY = {
  newsletter: {
    label: 'Newsletter',
    hint: 'Occasional news and updates from Ai4L.',
  },
  programs: {
    label: 'Courses and training',
    hint: 'Invitations to courses, training and programmes.',
  },
} as const

/** The state a per-stream link asks for, applied on top of what the contact has now. */
function applyRequest(initial: ConsentState, requested: Props['requested']): ConsentState {
  if (requested === 'newsletter') return { ...initial, newsletter: false }
  if (requested === 'programs') return { ...initial, programs: false }
  if (requested === 'all') return { newsletter: false, programs: false }

  return initial
}

/**
 * The reader's own consent controls.
 *
 * Nothing here happens on load. The page can be opened by a mail scanner following
 * every link in the email before a human sees it, so a change only ever leaves on a
 * POST the reader triggered — see the route for the full reasoning.
 */
export default function PreferencesForm({ token, initial, requested }: Props) {
  const [choice, setChoice] = useState<ConsentState>(() => applyRequest(initial, requested))
  const [saved, setSaved] = useState<ConsentState | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (next: ConsentState) => {
    setIsSaving(true)
    setError(null)

    try {
      const response = await fetch(`/api/preferences/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })

      const body = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(body.error || 'Could not save your preferences.')
      }

      // What the server reports, not what was asked for: withdrawing the last consent
      // has effects beyond the two flags, and the reader should see what is true.
      const applied: ConsentState = {
        newsletter: Boolean(body.newsletter),
        programs: Boolean(body.programs),
      }

      setChoice(applied)
      setSaved(applied)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save your preferences.')
    } finally {
      setIsSaving(false)
    }
  }

  const toggle = (stream: keyof ConsentState) => {
    setSaved(null)
    setChoice((current) => ({ ...current, [stream]: !current[stream] }))
  }

  const nothingLeft = saved !== null && !saved.newsletter && !saved.programs

  return (
    <>
      {saved !== null && (
        <p className={styles.saved} role="status" data-testid="preferences-saved">
          {nothingLeft
            ? 'Saved. You will not receive any more email from us.'
            : 'Saved. Your preferences have been updated.'}
        </p>
      )}

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.choices}>
        {(['newsletter', 'programs'] as const).map((stream) => (
          <label
            key={stream}
            className={`${styles.choice} ${choice[stream] ? styles.choiceOn : ''}`}
          >
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={choice[stream]}
              onChange={() => toggle(stream)}
              disabled={isSaving}
              data-testid={`consent-${stream}`}
            />
            <span className={styles.choiceText}>
              <span className={styles.choiceLabel}>{COPY[stream].label}</span>
              <span className={styles.choiceHint}>{COPY[stream].hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.cta}
          onClick={() => void save(choice)}
          disabled={isSaving}
          data-testid="save-preferences"
        >
          {isSaving ? 'Saving…' : 'Save my preferences'}
        </button>

        <button
          type="button"
          className={styles.secondary}
          onClick={() => void save({ newsletter: false, programs: false })}
          disabled={isSaving}
          data-testid="unsubscribe-all"
        >
          Unsubscribe from everything
        </button>
      </div>
    </>
  )
}

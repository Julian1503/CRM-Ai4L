'use client'

import { useEffect, useState } from 'react'

import styles from './marketing.module.css'
import type { SegmentActions } from './SegmentDrawer'

type Candidate = {
  id: string
  first_name: string
  last_name: string
  email: string
  subscribed_to_newsletter: boolean
  subscribed_to_programs: boolean
}

const RESULTS = 10

function consentNote(candidate: Pick<Candidate, 'subscribed_to_newsletter' | 'subscribed_to_programs'>): string | null {
  if (!candidate.subscribed_to_newsletter && !candidate.subscribed_to_programs) {
    return 'Has not agreed to any email, so will not receive anything from this segment.'
  }
  if (!candidate.subscribed_to_newsletter) return 'Will only receive course & training emails.'
  if (!candidate.subscribed_to_programs) return 'Will only receive newsletter emails.'
  return null
}

/**
 * Finds any active contact and adds them to the segment by hand, even if the filters
 * would leave them out. Consent still applies: the note under each person says what
 * they will and will not receive.
 */
export default function SegmentAddPeopleTab({ actions }: { actions: SegmentActions }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Candidate[]>([])
  const [added, setAdded] = useState<Record<string, string | null>>({})

  useEffect(() => {
    const term = query.trim()

    if (term.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([])
      return
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/contacts?q=${encodeURIComponent(term)}&pageSize=${RESULTS}`)
      const body = response.ok ? await response.json() : { contacts: [] }
      if (!cancelled) setResults(body.contacts ?? [])
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const include = async (candidate: Candidate) => {
    const consent = await actions.decide(candidate.id, 'include')

    if (consent) {
      setAdded((current) => ({
        ...current,
        [candidate.id]: consentNote({
          subscribed_to_newsletter: consent.newsletter,
          subscribed_to_programs: consent.programs,
        }),
      }))
    }
  }

  return (
    <>
      <label className={styles.field}>
        <span className={styles.label}>Find a contact</span>
        <input
          className={styles.input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, email or organisation"
          data-testid="add-people-search"
        />
      </label>

      <ul className={styles.list}>
        {query.trim().length >= 2 && results.length === 0 && <li className={styles.empty}>No contacts found.</li>}
        {results.map((candidate) => {
          const isAdded = candidate.id in added
          const note = isAdded ? added[candidate.id] : consentNote(candidate)

          return (
            <li key={candidate.id} className={styles.listItem} data-testid={`candidate-${candidate.id}`}>
              <span className={styles.campaignMain}>
                <span className={styles.itemName}>
                  {candidate.first_name} {candidate.last_name}
                </span>
                <span className={styles.itemMeta}>{candidate.email}</span>
                {note && <span className={styles.checkFailed}>{note}</span>}
              </span>
              <span className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => void include(candidate)}
                  disabled={actions.locked || isAdded}
                  data-testid={`include-${candidate.id}`}
                >
                  {isAdded ? 'Added' : 'Add to segment'}
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => void actions.decide(candidate.id, 'exclude')}
                  disabled={actions.locked}
                  data-testid={`candidate-exclude-${candidate.id}`}
                >
                  Exclude
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </>
  )
}

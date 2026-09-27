'use client'

import { useEffect, useState } from 'react'

import type { SegmentFacets } from '@/lib/marketing/facets'

import styles from './marketing.module.css'
import SegmentCriteriaFields, { type CriteriaDraft } from './SegmentCriteriaFields'
import type { SegmentSummary } from './SegmentsPanel'

type Option = { id: string; name: string }

function toDraft(definition: Record<string, unknown>): CriteriaDraft {
  return Object.fromEntries(
    Object.entries(definition).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

/**
 * Edit the segment's name, description and criteria, with a live count that includes
 * its manual decisions, so the number shown is what saving would give.
 */
export default function SegmentFiltersTab({
  segment,
  jobTypes,
  locked,
  onSaved,
}: {
  segment: SegmentSummary
  jobTypes: Option[]
  locked: boolean
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(segment.name)
  const [description, setDescription] = useState(segment.description ?? '')
  const [criteria, setCriteria] = useState<CriteriaDraft>(() => toDraft(segment.definition ?? {}))
  const [preview, setPreview] = useState<{ total: number; facets?: SegmentFacets } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/segments/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segmentId: segment.id, definition: criteria }),
        })
        setPreview(response.ok ? await response.json() : null)
      } catch {
        setPreview(null)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [segment.id, criteria])

  const save = async () => {
    setBusy(true)
    setMessage(null)

    try {
      const response = await fetch(`/api/segments/${segment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, definition: criteria }),
      })
      const body = await response.json().catch(() => ({}))

      if (!response.ok) throw new Error(body.error || `Request failed (HTTP ${response.status})`)

      setMessage({ ok: true, text: 'Saved.' })
      await onSaved()
    } catch (saveError) {
      setMessage({ ok: false, text: saveError instanceof Error ? saveError.message : 'Could not save.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            className={styles.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={locked}
            data-testid="edit-segment-name"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Description</span>
          <input
            className={styles.input}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={locked}
            data-testid="edit-segment-description"
          />
        </label>
      </div>

      <SegmentCriteriaFields
        value={criteria}
        onChange={setCriteria}
        jobTypes={jobTypes}
        facets={preview?.facets}
        testIdPrefix="edit-segment"
        disabled={locked}
      />

      <div className={styles.previewRow}>
        <div className={styles.preview} data-testid="edit-segment-preview">
          {preview ? (
            <>
              <span className={styles.previewCount}>{preview.total}</span>
              <span className={styles.previewLabel}>newsletter subscribers, counting manual decisions</span>
            </>
          ) : (
            <span className={styles.previewLabel}>Counting…</span>
          )}
        </div>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={save}
          disabled={locked || busy || !name.trim()}
          data-testid="save-segment"
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {message && (
        <p className={message.ok ? styles.checkOk : styles.checkFailed} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </>
  )
}

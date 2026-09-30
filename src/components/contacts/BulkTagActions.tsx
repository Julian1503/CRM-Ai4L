'use client'

import React, { useId, useState } from 'react'

import { MAX_SELECTED_IDS } from '@/lib/contacts/query'
import { MAX_TAGS_PER_CONTACT } from '@/lib/db/types'

import styles from './BulkTagActions.module.css'
import TagPicker, { type TagOption } from './TagPicker'
import { readErrorMessage } from './useRemoteSearch'

/**
 * Adds or removes tags on the contacts ticked in the table, across pages.
 *
 * Works on the explicit ids only — an empty selection never means "everyone". The
 * exact count is spelled out on the apply button before anything is sent, and the
 * selection is left alone when the request fails so the user can retry.
 */

export type BulkTagOperation = 'add' | 'remove'

export type BulkTagResult = { operation: BulkTagOperation; tagIds: string[]; updated: number }

export interface BulkTagActionsProps {
  /** Contact ids currently selected (all pages). */
  selectedIds: readonly string[]
  /** Called after a successful apply; the page should refetch contacts. */
  onApplied: (result: BulkTagResult) => void
  disabled?: boolean
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function describeBulkTagAction(
  operation: BulkTagOperation,
  tagCount: number,
  contactCount: number,
  tense: 'pending' | 'done' = 'pending'
): string {
  const tags = plural(tagCount, 'tag', 'tags')
  const contacts = plural(contactCount, 'contact', 'contacts')
  const verb =
    operation === 'add' ? (tense === 'done' ? 'Added' : 'Add') : tense === 'done' ? 'Removed' : 'Remove'

  return `${verb} ${tags} ${operation === 'add' ? 'to' : 'from'} ${contacts}`
}

export default function BulkTagActions({ selectedIds, onApplied, disabled = false }: BulkTagActionsProps) {
  const panelId = useId()
  const [isOpen, setIsOpen] = useState(false)
  const [operation, setOperation] = useState<BulkTagOperation>('add')
  const [tags, setTags] = useState<TagOption[]>([])
  const [isApplying, setIsApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const count = selectedIds.length
  const isTooLarge = count > MAX_SELECTED_IDS
  const canApply = !disabled && !isApplying && count > 0 && !isTooLarge && tags.length > 0

  const apply = async () => {
    if (!canApply) return

    const tagIds = tags.map((tag) => tag.id)
    const done = describeBulkTagAction(operation, tags.length, count, 'done')
    setIsApplying(true)
    setError(null)
    setStatus(null)

    try {
      const response = await fetch('/api/contacts/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: [...selectedIds], tagIds, operation }),
      })

      if (response.status === 409) {
        throw new Error(
          `${await readErrorMessage(response, 'The selection is out of date')} Refresh the list and check the selection, then try again.`
        )
      }

      if (!response.ok) throw new Error(await readErrorMessage(response, 'Could not update tags'))

      const body = (await response.json().catch(() => ({}))) as { updated?: unknown }
      const updated = typeof body.updated === 'number' ? body.updated : count

      setTags([])
      setStatus(`${done}.`)
      onApplied({ operation, tagIds, updated })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update tags.')
    } finally {
      setIsApplying(false)
    }
  }

  if (count === 0 && !status) return null

  return (
    <div className={styles.root} data-testid="bulk-tag-actions">
      {count > 0 && (
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={isOpen}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => setIsOpen((open) => !open)}
      >
        Tag {count} selected
      </button>
      )}

      {isOpen && count > 0 && (
        <div id={panelId} className={styles.panel} role="group" aria-label="Tag selected contacts">
          <div className={styles.operation} role="radiogroup" aria-label="Tag operation">
            {(['add', 'remove'] as const).map((value) => (
              <label key={value} className={`${styles.segment} ${operation === value ? styles.segmentActive : ''}`}>
                <input
                  type="radio"
                  name={`${panelId}-operation`}
                  value={value}
                  className={styles.srOnly}
                  checked={operation === value}
                  onChange={() => {
                    setOperation(value)
                    setError(null)
                    setStatus(null)
                  }}
                />
                {value === 'add' ? 'Add tags' : 'Remove tags'}
              </label>
            ))}
          </div>

          <TagPicker
            value={tags}
            onChange={(next) => {
              setTags(next)
              setError(null)
              setStatus(null)
            }}
            label={operation === 'add' ? 'Tags to add' : 'Tags to remove'}
            allowCreate={operation === 'add'}
            maxTags={MAX_TAGS_PER_CONTACT}
            disabled={disabled || isApplying}
            testId="bulk-tag-picker"
          />

          {isTooLarge && (
            <p className={styles.error} role="alert">
              {count} contacts are selected. Tags can be changed on at most {MAX_SELECTED_IDS} at a
              time — narrow the selection first.
            </p>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.applyBtn}
              onClick={() => void apply()}
              disabled={!canApply}
              data-testid="bulk-tag-apply"
            >
              {isApplying
                ? 'Applying…'
                : tags.length > 0
                  ? describeBulkTagAction(operation, tags.length, count)
                  : 'Choose tags to apply'}
            </button>
          </div>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {status && (
        <p className={styles.status} role="status">
          {status}
        </p>
      )}
    </div>
  )
}

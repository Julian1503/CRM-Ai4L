'use client'

import React, { useId, useState } from 'react'

import { readErrorMessage, useRemoteSearch } from '@/components/contacts/useRemoteSearch'
import {
  JOB_TYPE_NAME_MAX_LENGTH,
  duplicateJobTypeMessage,
  findDuplicateJobType,
  validateJobTypeName,
  type JobTypeOption,
} from '@/lib/contacts/jobTypes'

import styles from './CatalogSettings.module.css'

/**
 * Settings > Job Types: browse, add and rename the job-type catalogue without SQL.
 *
 * Renaming keeps the id, so every contact and segment that uses the type follows the
 * new name. There is no delete: removing a type in use would silently empty segments.
 */

export type JobTypeChange = { kind: 'created' | 'renamed'; jobType: JobTypeOption }

export interface JobTypesSettingsProps {
  /** Called after a create or rename succeeds, so the page can refresh its options. */
  onChanged?: (change: JobTypeChange) => void
  pageSize?: number
}

type Message = { kind: 'error' | 'success'; text: string } | null

const selectJobTypes = (body: Record<string, unknown>): JobTypeOption[] =>
  Array.isArray(body.jobTypes) ? (body.jobTypes as JobTypeOption[]) : []

export default function JobTypesSettings({ onChanged, pageSize = 20 }: JobTypesSettingsProps) {
  const ids = useId()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [message, setMessage] = useState<Message>(null)

  const { items, total, hasMore, isLoading, error, reload } = useRemoteSearch({
    url: '/api/job-types',
    query,
    page,
    pageSize,
    select: selectJobTypes,
  })

  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const validated = validateJobTypeName(newName)

    if (!validated.ok) {
      setCreateError(validated.error)
      return
    }

    if (findDuplicateJobType(validated.name, items)) {
      setCreateError(duplicateJobTypeMessage(validated.name))
      return
    }

    setIsCreating(true)
    setCreateError(null)
    setMessage(null)

    try {
      const response = await fetch('/api/job-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: validated.name }),
      })

      if (!response.ok) throw new Error(await readErrorMessage(response, 'Could not add the job type'))

      const { jobType } = (await response.json()) as { jobType: JobTypeOption }

      setNewName('')
      setMessage({ kind: 'success', text: `Added "${jobType.name}".` })
      reload()
      onChanged?.({ kind: 'created', jobType })
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : 'Could not add the job type.')
    } finally {
      setIsCreating(false)
    }
  }

  const startRename = (jobType: JobTypeOption) => {
    setEditing({ id: jobType.id, name: jobType.name })
    setRenameError(null)
    setMessage(null)
  }

  const cancelRename = () => {
    setEditing(null)
    setRenameError(null)
  }

  const saveRename = async (original: JobTypeOption) => {
    if (!editing) return
    const validated = validateJobTypeName(editing.name)

    if (!validated.ok) {
      setRenameError(validated.error)
      return
    }

    if (validated.name === original.name) {
      cancelRename()
      return
    }

    if (findDuplicateJobType(validated.name, items, original.id)) {
      setRenameError(duplicateJobTypeMessage(validated.name))
      return
    }

    setIsRenaming(true)
    setRenameError(null)

    try {
      const response = await fetch(`/api/job-types/${encodeURIComponent(original.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: validated.name }),
      })

      if (!response.ok) throw new Error(await readErrorMessage(response, 'Could not rename the job type'))

      const { jobType } = (await response.json()) as { jobType: JobTypeOption }

      setEditing(null)
      setMessage({ kind: 'success', text: `Renamed "${original.name}" to "${jobType.name}".` })
      reload()
      onChanged?.({ kind: 'renamed', jobType })
    } catch (caught) {
      setRenameError(caught instanceof Error ? caught.message : 'Could not rename the job type.')
    } finally {
      setIsRenaming(false)
    }
  }

  const renderRow = (jobType: JobTypeOption) => {
    if (editing?.id !== jobType.id) {
      return (
        <li key={jobType.id} className={styles.row} data-testid={`job-type-row-${jobType.id}`}>
          <span className={styles.rowMain}>
            <span className={styles.rowName}>{jobType.name}</span>
          </span>
          <span className={styles.rowActions}>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => startRename(jobType)}
              disabled={editing !== null}
              aria-label={`Rename ${jobType.name}`}
            >
              Rename
            </button>
          </span>
        </li>
      )
    }

    const inputId = `${ids}-rename-${jobType.id}`
    const errorId = `${inputId}-error`

    return (
      <li key={jobType.id} className={styles.row} data-testid={`job-type-row-${jobType.id}`}>
        <form
          className={styles.toolbar}
          style={{ marginBottom: 0, flex: '1 1 100%' }}
          onSubmit={(event) => {
            event.preventDefault()
            void saveRename(jobType)
          }}
        >
          <span className={styles.fieldGroup}>
            <label htmlFor={inputId} className={styles.srOnly}>
              New name for {jobType.name}
            </label>
            <input
              id={inputId}
              className={styles.input}
              value={editing.name}
              autoFocus
              aria-invalid={renameError ? 'true' : undefined}
              aria-describedby={renameError ? errorId : undefined}
              onChange={(event) => {
                setEditing({ id: jobType.id, name: event.target.value })
                setRenameError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRename()
                }
              }}
            />
          </span>
          <button type="submit" className={styles.primaryBtn} disabled={isRenaming}>
            {isRenaming ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={cancelRename} disabled={isRenaming}>
            Cancel
          </button>
        </form>
        {renameError && (
          <p id={errorId} className={styles.error} role="alert" style={{ flex: '1 1 100%' }}>
            {renameError}
          </p>
        )}
      </li>
    )
  }

  const searchId = `${ids}-search`
  const newId = `${ids}-new`
  const createErrorId = `${newId}-error`

  return (
    <section className="outerShell" aria-labelledby={`${ids}-title`} data-testid="job-types-settings">
      <div className={`innerCore ${styles.card}`}>
        <h2 id={`${ids}-title`} className={styles.title}>
          Job Types
        </h2>
        <p className={styles.intro}>
          Job types classify contacts for filters and segments. Renaming keeps every contact and
          segment attached to the same job type. Names must be unique, ignoring case, and at most{' '}
          {JOB_TYPE_NAME_MAX_LENGTH} characters.
        </p>

        <form className={styles.toolbar} onSubmit={create} noValidate>
          <span className={styles.fieldGroup}>
            <label htmlFor={newId} className={styles.label}>
              New job type
            </label>
            <input
              id={newId}
              className={styles.input}
              value={newName}
              placeholder="e.g. Registered Training Organisation"
              aria-invalid={createError ? 'true' : undefined}
              aria-describedby={createError ? createErrorId : undefined}
              onChange={(event) => {
                setNewName(event.target.value)
                setCreateError(null)
              }}
            />
          </span>
          <button type="submit" className={styles.primaryBtn} disabled={isCreating}>
            {isCreating ? 'Adding…' : 'Add job type'}
          </button>
        </form>
        {createError && (
          <p id={createErrorId} className={styles.error} role="alert">
            {createError}
          </p>
        )}

        <div className={styles.toolbar} style={{ marginTop: 'var(--space-md)' }}>
          <span className={styles.fieldGroup}>
            <label htmlFor={searchId} className={styles.label}>
              Search job types
            </label>
            <input
              id={searchId}
              type="search"
              className={styles.input}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
            />
          </span>
        </div>

        {error ? (
          <p className={styles.error} role="alert">
            {error}{' '}
            <button type="button" className={styles.linkBtn} onClick={reload}>
              Retry
            </button>
          </p>
        ) : (
          <ul className={styles.list} aria-busy={isLoading} aria-label="Job types">
            {items.map(renderRow)}
            {!isLoading && items.length === 0 && (
              <li className={styles.empty}>
                {query.trim() ? 'No job types match this search.' : 'No job types yet.'}
              </li>
            )}
          </ul>
        )}

        <div className={styles.pager}>
          <span aria-live="polite">
            {isLoading ? 'Loading…' : `${total} ${total === 1 ? 'job type' : 'job types'} · page ${page} of ${pageCount}`}
          </span>
          <span className={styles.pagerButtons}>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1 || isLoading}
            >
              Previous
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => setPage((current) => current + 1)}
              disabled={!hasMore || isLoading}
            >
              Next
            </button>
          </span>
        </div>

        {message && (
          <p className={message.kind === 'error' ? styles.error : styles.success} role="status">
            {message.text}
          </p>
        )}
      </div>
    </section>
  )
}

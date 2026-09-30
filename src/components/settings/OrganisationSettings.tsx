'use client'

import React, { useEffect, useId, useState } from 'react'

import { readErrorMessage, useRemoteSearch } from '@/components/contacts/useRemoteSearch'

import styles from './CatalogSettings.module.css'

/**
 * Settings > Organisation industry: find an organisation and set its sector.
 *
 * Industry lives on the organisation, so one edit changes it for every contact there;
 * the card says so before anything is saved. Saves are guarded by the value the user
 * started from (`expectedIndustry`): if someone changed it meanwhile the server answers
 * 409, the conflict is shown and the list reloads with the current value.
 */

export type OrganisationSummary = { id: string; name: string; industry: string | null }

export interface OrganisationSettingsProps {
  /** Called after an industry is saved, so the page can refresh filters and contacts. */
  onChanged?: (organisation: OrganisationSummary) => void
  pageSize?: number
}

type Editing = { id: string; original: string | null; draft: string }

const selectOrganisations = (body: Record<string, unknown>): OrganisationSummary[] =>
  Array.isArray(body.organisations) ? (body.organisations as OrganisationSummary[]) : []

const cleanIndustry = (value: string): string | null => {
  const cleaned = value.trim().replace(/\s+/g, ' ')
  return cleaned === '' ? null : cleaned
}

export default function OrganisationSettings({ onChanged, pageSize = 20 }: OrganisationSettingsProps) {
  const ids = useId()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [industries, setIndustries] = useState<string[]>([])
  const [industriesVersion, setIndustriesVersion] = useState(0)

  const { items, total, hasMore, isLoading, error, reload } = useRemoteSearch({
    url: '/api/organisations',
    query,
    page,
    pageSize,
    select: selectOrganisations,
  })

  // Existing sectors, offered as suggestions so "Health" is not re-typed as "Healthcare".
  useEffect(() => {
    const controller = new AbortController()

    fetch('/api/organisations?facet=industry', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { industries: [] }))
      .then((body: { industries?: unknown }) => {
        setIndustries(Array.isArray(body.industries) ? (body.industries as string[]) : [])
      })
      .catch(() => {
        // Suggestions are a convenience; the editor works without them.
      })

    return () => controller.abort()
  }, [industriesVersion])

  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const startEdit = (organisation: OrganisationSummary) => {
    setEditing({ id: organisation.id, original: organisation.industry, draft: organisation.industry ?? '' })
    setEditError(null)
    setMessage(null)
  }

  const cancelEdit = () => {
    setEditing(null)
    setEditError(null)
  }

  const save = async (organisation: OrganisationSummary) => {
    if (!editing) return
    const industry = cleanIndustry(editing.draft)

    if (industry === editing.original) {
      cancelEdit()
      return
    }

    setIsSaving(true)
    setEditError(null)

    try {
      const response = await fetch(`/api/organisations/${encodeURIComponent(organisation.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ industry, expectedIndustry: editing.original }),
      })

      if (response.status === 409) {
        const reason = await readErrorMessage(response, 'The industry was changed by someone else')
        setEditing(null)
        setEditError(null)
        setMessage(null)
        setConflict(`${reason} The list has been reloaded with the current value — review it and edit again if needed.`)
        reload()
        return
      }

      if (!response.ok) throw new Error(await readErrorMessage(response, 'Could not save the industry'))

      const body = (await response.json()) as { organisation?: OrganisationSummary }
      const saved = body.organisation ?? { ...organisation, industry }

      setEditing(null)
      setConflict(null)
      setMessage(
        saved.industry
          ? `${saved.name} is now in "${saved.industry}".`
          : `Cleared the industry of ${saved.name}.`
      )
      reload()
      setIndustriesVersion((version) => version + 1)
      onChanged?.(saved)
    } catch (caught) {
      setEditError(caught instanceof Error ? caught.message : 'Could not save the industry.')
    } finally {
      setIsSaving(false)
    }
  }

  const datalistId = `${ids}-industries`

  const renderRow = (organisation: OrganisationSummary) => {
    const isEditing = editing?.id === organisation.id

    if (!isEditing || !editing) {
      return (
        <li key={organisation.id} className={styles.row} data-testid={`organisation-row-${organisation.id}`}>
          <span className={styles.rowMain}>
            <span className={styles.rowName}>{organisation.name}</span>
            <span className={styles.rowMeta}>{organisation.industry ?? 'No industry set'}</span>
          </span>
          <span className={styles.rowActions}>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => startEdit(organisation)}
              disabled={editing !== null}
              aria-label={`Edit industry of ${organisation.name}`}
            >
              Edit industry
            </button>
          </span>
        </li>
      )
    }

    const inputId = `${ids}-industry-${organisation.id}`
    const noteId = `${inputId}-note`
    const errorId = `${inputId}-error`

    return (
      <li key={organisation.id} className={styles.row} data-testid={`organisation-row-${organisation.id}`}>
        <form
          className={styles.toolbar}
          style={{ marginBottom: 0, flex: '1 1 100%' }}
          onSubmit={(event) => {
            event.preventDefault()
            void save(organisation)
          }}
        >
          <span className={styles.fieldGroup}>
            <label htmlFor={inputId} className={styles.label}>
              Industry of {organisation.name}
            </label>
            <input
              id={inputId}
              className={styles.input}
              value={editing.draft}
              list={datalistId}
              autoFocus
              placeholder="Leave empty to clear"
              aria-describedby={[noteId, editError ? errorId : null].filter(Boolean).join(' ')}
              aria-invalid={editError ? 'true' : undefined}
              onChange={(event) => {
                setEditing({ ...editing, draft: event.target.value })
                setEditError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelEdit()
                }
              }}
            />
          </span>
          <button type="submit" className={styles.primaryBtn} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={cancelEdit} disabled={isSaving}>
            Cancel
          </button>
        </form>
        <p id={noteId} className={styles.rowMeta} style={{ flex: '1 1 100%', margin: 0 }}>
          This changes the industry for every contact at {organisation.name}.
        </p>
        {editError && (
          <p id={errorId} className={styles.error} role="alert" style={{ flex: '1 1 100%' }}>
            {editError}
          </p>
        )}
      </li>
    )
  }

  const searchId = `${ids}-search`

  return (
    <section className="outerShell" aria-labelledby={`${ids}-title`} data-testid="organisation-settings">
      <div className={`innerCore ${styles.card}`}>
        <h2 id={`${ids}-title`} className={styles.title}>
          Organisation industry
        </h2>
        <p className={styles.intro}>
          Industry is the sector of an organisation, separate from a contact&apos;s job type. It
          belongs to the organisation, so a change applies to all of its contacts and to the
          Industry filter.
        </p>

        <div className={styles.toolbar}>
          <span className={styles.fieldGroup}>
            <label htmlFor={searchId} className={styles.label}>
              Search organisations
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

        {conflict && (
          <p className={styles.error} role="alert" data-testid="organisation-conflict">
            {conflict}
          </p>
        )}

        {error ? (
          <p className={styles.error} role="alert">
            {error}{' '}
            <button type="button" className={styles.linkBtn} onClick={reload}>
              Retry
            </button>
          </p>
        ) : (
          <ul className={styles.list} aria-busy={isLoading} aria-label="Organisations" style={{ marginTop: 'var(--space-sm)' }}>
            {items.map(renderRow)}
            {!isLoading && items.length === 0 && (
              <li className={styles.empty}>
                {query.trim() ? 'No organisations match this search.' : 'No organisations yet.'}
              </li>
            )}
          </ul>
        )}

        <datalist id={datalistId}>
          {industries.map((industry) => (
            <option key={industry} value={industry} />
          ))}
        </datalist>

        <div className={styles.pager}>
          <span aria-live="polite">
            {isLoading
              ? 'Loading…'
              : `${total} ${total === 1 ? 'organisation' : 'organisations'} · page ${page} of ${pageCount}`}
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
          <p className={styles.success} role="status">
            {message}
          </p>
        )}
      </div>
    </section>
  )
}

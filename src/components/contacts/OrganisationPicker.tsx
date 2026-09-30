'use client'

import React, { useEffect, useId, useRef, useState } from 'react'

import styles from './OrganisationPicker.module.css'
import { useRemoteSearch } from './useRemoteSearch'

/**
 * Single-organisation combobox backed by `GET /api/organisations`.
 *
 * Options are searched and paged on the server — never derived from the contacts on
 * screen, which would only ever offer organisations the current page happens to show.
 * Controlled: the caller owns the selection (the page keeps it in the URL as
 * `organisationId`).
 */

export type OrganisationOption = { id: string; name: string; industry?: string | null }

export interface OrganisationPickerProps {
  value: OrganisationOption | null
  onChange: (organisation: OrganisationOption | null) => void
  label?: string
  /** Text for the "nothing selected" state. */
  placeholder?: string
  disabled?: boolean
  testId?: string
  /** Visual density: `compact` sits in the filter row, `field` in forms. */
  variant?: 'compact' | 'field'
}

const PAGE_STEP = 20
const MAX_PAGE_SIZE = 200

const selectOrganisations = (body: Record<string, unknown>): OrganisationOption[] =>
  Array.isArray(body.organisations) ? (body.organisations as OrganisationOption[]) : []

export default function OrganisationPicker({
  value,
  onChange,
  label = 'Organisation',
  placeholder = 'All organisations',
  disabled = false,
  testId = 'organisation-picker',
  variant = 'compact',
}: OrganisationPickerProps) {
  const baseId = useId()
  const inputId = `${baseId}-input`
  const listboxId = `${baseId}-listbox`
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pageSize, setPageSize] = useState(PAGE_STEP)
  const rootRef = useRef<HTMLDivElement>(null)

  const search = useRemoteSearch({
    url: '/api/organisations',
    query,
    pageSize,
    select: selectOrganisations,
    enabled: isOpen && !disabled,
  })

  useEffect(() => {
    if (!isOpen) return

    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setIsOpen(false)
    }

    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [isOpen])

  const options = search.items
  const safeActive = Math.min(activeIndex, Math.max(0, options.length - 1))

  const choose = (organisation: OrganisationOption | undefined) => {
    if (!organisation) return
    onChange(organisation)
    setQuery('')
    setIsOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setIsOpen(true)
        setActiveIndex(options.length ? (safeActive + 1) % options.length : 0)
        break
      case 'ArrowUp':
        event.preventDefault()
        setIsOpen(true)
        setActiveIndex(options.length ? (safeActive - 1 + options.length) % options.length : 0)
        break
      case 'Enter':
        event.preventDefault()
        if (isOpen) choose(options[safeActive])
        break
      case 'Escape':
        if (isOpen) {
          event.preventDefault()
          event.stopPropagation()
          setIsOpen(false)
          setQuery('')
        }
        break
      default:
        break
    }
  }

  const showList = isOpen && !disabled
  const activeId = showList && options.length ? `${baseId}-option-${safeActive}` : undefined
  const displayValue = isOpen ? query : (value?.name ?? '')

  return (
    <div
      ref={rootRef}
      className={`${styles.root} ${variant === 'compact' ? styles.compact : styles.field}`}
      data-testid={testId}
    >
      <label htmlFor={inputId} className={styles.label}>
        {label}
      </label>
      <div className={styles.control}>
        <input
          id={inputId}
          type="text"
          role="combobox"
          className={styles.input}
          value={displayValue}
          placeholder={value ? value.name : placeholder}
          disabled={disabled}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          data-testid={`${testId}-input`}
          onFocus={() => {
            setIsOpen(true)
            setQuery('')
          }}
          onChange={(event) => {
            setQuery(event.target.value)
            setIsOpen(true)
            setActiveIndex(0)
            setPageSize(PAGE_STEP)
          }}
          onKeyDown={onKeyDown}
        />
        {value && !disabled && (
          <button
            type="button"
            className={styles.clear}
            aria-label={`Clear organisation filter ${value.name}`}
            data-testid={`${testId}-clear`}
            onClick={() => {
              onChange(null)
              setIsOpen(false)
              setQuery('')
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {showList && (
        <ul id={listboxId} role="listbox" className={styles.listbox} aria-label={`${label} options`}>
          {options.map((organisation, index) => (
            <li
              key={organisation.id}
              id={`${baseId}-option-${index}`}
              role="option"
              aria-selected={value?.id === organisation.id}
              className={`${styles.option} ${index === safeActive ? styles.optionActive : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(organisation)}
            >
              <span className={styles.optionName}>{organisation.name}</span>
              {organisation.industry && <span className={styles.optionMeta}>{organisation.industry}</span>}
            </li>
          ))}
          {search.isLoading && <li className={styles.status}>Searching…</li>}
          {!search.isLoading && search.error && <li className={styles.status}>{search.error}</li>}
          {!search.isLoading && !search.error && options.length === 0 && (
            <li className={styles.status}>No organisations match.</li>
          )}
          {!search.isLoading && search.hasMore && pageSize < MAX_PAGE_SIZE && (
            <li className={styles.status}>
              <button
                type="button"
                className={styles.more}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setPageSize((size) => Math.min(MAX_PAGE_SIZE, size + PAGE_STEP))}
              >
                Show more ({search.total - options.length} not shown)
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

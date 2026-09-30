'use client'

import React, { useEffect, useId, useRef, useState } from 'react'

import { MAX_TAGS_PER_CONTACT, TAG_NAME_MAX_LENGTH } from '@/lib/db/types'
import { normalizeTagName, tagKey } from '@/lib/contacts/tags'

import styles from './TagPicker.module.css'
import { readErrorMessage, useRemoteSearch } from './useRemoteSearch'

/**
 * Picks CRM tags: search the catalogue, create a missing tag, remove chips.
 *
 * Controlled — the caller owns the selection. Used by the contact drawer, the bulk
 * tag action and the import screen. Keyboard: arrows move through suggestions, Enter
 * picks (or creates), Escape closes, Backspace in an empty field removes the last chip.
 */

export type TagOption = { id: string; name: string }

export interface TagPickerProps {
  value: readonly TagOption[]
  onChange: (tags: TagOption[]) => void
  /** Visible label. Defaults to "Tags". */
  label?: string
  /** Hides the label visually while keeping it for assistive technology. */
  hideLabel?: boolean
  /** Short explanation rendered under the field. */
  hint?: string
  /** Most tags that may be selected. Defaults to MAX_TAGS_PER_CONTACT (50). */
  maxTags?: number
  /** Offer "Create …" when nothing matches. Defaults to true. */
  allowCreate?: boolean
  disabled?: boolean
  placeholder?: string
  /** Prefix for test ids, so two pickers on one screen stay distinguishable. */
  testId?: string
  /** `field` (default) stacks the label above; `compact` sits inline in the filter row. */
  variant?: 'field' | 'compact'
}

type Suggestion = { kind: 'existing'; tag: TagOption } | { kind: 'create'; name: string }

const SUGGESTION_PAGE_SIZE = 20

const selectTags = (body: Record<string, unknown>): TagOption[] =>
  Array.isArray(body.tags) ? (body.tags as TagOption[]) : []

export default function TagPicker({
  value,
  onChange,
  label = 'Tags',
  hideLabel = false,
  hint,
  maxTags = MAX_TAGS_PER_CONTACT,
  allowCreate = true,
  disabled = false,
  placeholder = 'Search or create a tag…',
  testId = 'tag-picker',
  variant = 'field',
}: TagPickerProps) {
  const baseId = useId()
  const inputId = `${baseId}-input`
  const listboxId = `${baseId}-listbox`
  const hintId = `${baseId}-hint`
  const errorId = `${baseId}-error`

  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const search = useRemoteSearch({
    url: '/api/tags',
    query,
    pageSize: SUGGESTION_PAGE_SIZE,
    select: selectTags,
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

  const selectedKeys = new Set(value.map((tag) => tagKey(tag.name)))
  const selectedIds = new Set(value.map((tag) => tag.id))
  const typed = normalizeTagName(query)
  const typedKey = typed.toLowerCase()
  const isAtLimit = value.length >= maxTags

  const suggestions: Suggestion[] = search.items
    .filter((tag) => !selectedIds.has(tag.id))
    .map((tag) => ({ kind: 'existing', tag }))

  const hasExactMatch =
    selectedKeys.has(typedKey) || search.items.some((tag) => tagKey(tag.name) === typedKey)

  if (allowCreate && typed && !hasExactMatch && !search.isLoading) {
    suggestions.push({ kind: 'create', name: typed })
  }

  const safeActive = Math.min(activeIndex, Math.max(0, suggestions.length - 1))

  const addTag = (tag: TagOption) => {
    if (selectedIds.has(tag.id)) return

    if (isAtLimit) {
      setError(`At most ${maxTags} tags can be selected.`)
      return
    }

    onChange([...value, tag])
    setQuery('')
    setActiveIndex(0)
    setError(null)
    inputRef.current?.focus()
  }

  const createTag = async (name: string) => {
    if (name.length > TAG_NAME_MAX_LENGTH) {
      setError(`Tag names can be at most ${TAG_NAME_MAX_LENGTH} characters.`)
      return
    }

    if (isAtLimit) {
      setError(`At most ${maxTags} tags can be selected.`)
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      const response = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })

      if (!response.ok) throw new Error(await readErrorMessage(response, 'Could not create the tag'))

      const { tag } = (await response.json()) as { tag: TagOption }
      addTag(tag)
      search.reload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the tag.')
    } finally {
      setIsCreating(false)
    }
  }

  const choose = (suggestion: Suggestion | undefined) => {
    if (!suggestion) return
    if (suggestion.kind === 'existing') addTag(suggestion.tag)
    else void createTag(suggestion.name)
  }

  const removeTag = (id: string) => {
    onChange(value.filter((tag) => tag.id !== id))
    setError(null)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setIsOpen(true)
        setActiveIndex(suggestions.length ? (safeActive + 1) % suggestions.length : 0)
        break
      case 'ArrowUp':
        event.preventDefault()
        setIsOpen(true)
        setActiveIndex(
          suggestions.length ? (safeActive - 1 + suggestions.length) % suggestions.length : 0
        )
        break
      case 'Enter':
        // Never submits the surrounding form: Enter here means "pick this tag".
        event.preventDefault()
        if (isOpen) choose(suggestions[safeActive])
        break
      case 'Escape':
        if (isOpen) {
          event.preventDefault()
          event.stopPropagation()
          setIsOpen(false)
        }
        break
      case 'Backspace':
        if (query === '' && value.length > 0) removeTag(value[value.length - 1].id)
        break
      default:
        break
    }
  }

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
  const showList = isOpen && !disabled
  const activeId = showList && suggestions.length ? `${baseId}-option-${safeActive}` : undefined

  return (
    <div
      ref={rootRef}
      className={`${styles.root} ${variant === 'compact' ? styles.compact : ''}`}
      data-testid={testId}
    >
      <label htmlFor={inputId} className={hideLabel ? styles.srOnly : styles.label}>
        {label}
      </label>

      <div className={`${styles.control} ${disabled ? styles.controlDisabled : ''}`}>
        {value.length > 0 && (
          <ul className={styles.chips} aria-label={`Selected ${label.toLowerCase()}`}>
            {value.map((tag) => (
              <li key={tag.id} className={styles.chip}>
                <span className={styles.chipName}>{tag.name}</span>
                <button
                  type="button"
                  className={styles.chipRemove}
                  onClick={() => removeTag(tag.id)}
                  disabled={disabled}
                  aria-label={`Remove tag ${tag.name}`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}

        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          className={styles.input}
          value={query}
          placeholder={isAtLimit ? `Limit of ${maxTags} reached` : placeholder}
          disabled={disabled || isCreating}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          aria-describedby={describedBy}
          aria-invalid={error ? 'true' : undefined}
          data-testid={`${testId}-input`}
          onFocus={() => setIsOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setIsOpen(true)
            setActiveIndex(0)
            setError(null)
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {showList && (
        <ul id={listboxId} role="listbox" className={styles.listbox} aria-label={`${label} suggestions`}>
          {search.isLoading && <li className={styles.status}>Searching…</li>}
          {!search.isLoading && search.error && <li className={styles.status}>{search.error}</li>}
          {!search.isLoading && !search.error && suggestions.length === 0 && (
            <li className={styles.status}>{typed ? 'No matching tags.' : 'No tags yet. Type to create one.'}</li>
          )}
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.kind === 'existing' ? suggestion.tag.id : `create-${suggestion.name}`}
              id={`${baseId}-option-${index}`}
              role="option"
              aria-selected={index === safeActive}
              className={`${styles.option} ${index === safeActive ? styles.optionActive : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(suggestion)}
            >
              {suggestion.kind === 'existing' ? (
                suggestion.tag.name
              ) : (
                <span>
                  Create <strong>&ldquo;{suggestion.name}&rdquo;</strong>
                </span>
              )}
            </li>
          ))}
          {search.hasMore && !search.isLoading && (
            <li className={styles.status}>More tags match — keep typing to narrow the list.</li>
          )}
        </ul>
      )}

      {hint && (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

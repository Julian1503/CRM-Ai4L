'use client'

import { useId, useState } from 'react'
import type { FormEvent } from 'react'

import type { ContentAsset, ContentVariant, RevisionContent } from '@/lib/content-studio/types'

import { ApiError, errorMessage, saveRevision } from './api'
import AssetSelection from './AssetSelection'
import { useIdempotencyKey } from './hooks'
import { parseHashtags, parseHttpsUrl } from './labels'
import { contentOf } from './revision'
import styles from './ContentStudio.module.css'
import variantStyles from './Variant.module.css'

/** Slots of the `studio-newsletter-v1` template, in reading order. */
export const EMAIL_FIELDS: { key: string; label: string; multiline?: boolean }[] = [
  { key: 'subject', label: 'Subject' },
  { key: 'preheader', label: 'Preheader' },
  { key: 'headline', label: 'Headline' },
  { key: 'intro', label: 'Intro', multiline: true },
  { key: 'body', label: 'Body block', multiline: true },
  { key: 'ctaLabel', label: 'Button label' },
]

type VariantEditorProps = {
  variant: ContentVariant
  assets: ContentAsset[]
  onSaved: () => void
  /** Reload the item from the server; the draft here is kept. */
  onReload: () => void
  onCancel: () => void
}

type Draft = {
  body: string
  hashtags: string
  callToAction: string
  linkUrl: string
  fields: Record<string, string>
  assets: RevisionContent['assets']
}

function draftFrom(variant: ContentVariant): Draft {
  const content = contentOf(variant.current)
  return {
    body: content.body,
    hashtags: content.hashtags.join(' '),
    callToAction: content.callToAction ?? '',
    linkUrl: content.linkUrl ?? '',
    fields: content.fields,
    assets: content.assets,
  }
}

export function contentFromDraft(draft: Draft, isEmail: boolean): RevisionContent {
  const fields = isEmail
    ? Object.fromEntries(Object.entries(draft.fields).map(([key, value]) => [key, value.trim()]))
    : draft.fields
  return {
    body: draft.body.trim(),
    hashtags: parseHashtags(draft.hashtags),
    callToAction: draft.callToAction.trim() || null,
    linkUrl: draft.linkUrl.trim() || null,
    fields,
    assets: draft.assets,
  }
}

/**
 * Edits a variant by saving a new revision. The save names the revision it was based
 * on; if someone saved in the meantime the server answers 409 stale_revision and the
 * draft stays on screen, untouched, next to the newer text.
 */
export default function VariantEditor({ variant, assets, onSaved, onReload, onCancel }: VariantEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(variant))
  const [baseRevisionId] = useState(variant.currentRevisionId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const { keyFor, settle } = useIdempotencyKey()
  const id = useId()
  const isEmail = variant.channel === 'email'
  const newerLoaded = variant.currentRevisionId !== baseRevisionId

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((previous) => ({ ...previous, [key]: value }))
  const setField = (key: string, value: string) => set('fields', { ...draft.fields, [key]: value })

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (draft.linkUrl.trim() && !parseHttpsUrl(draft.linkUrl)) {
      setLinkError('Use a full https:// address.')
      return
    }
    setLinkError(null)
    setBusy(true)
    setError(null)
    const content = contentFromDraft(draft, isEmail)
    const expectedRevisionId = variant.currentRevisionId
    try {
      const idempotencyKey = keyFor(JSON.stringify({ expectedRevisionId, content }))
      await saveRevision(variant.id, { idempotencyKey, expectedRevisionId, content })
      settle()
      setConflict(false)
      onSaved()
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.code === 'stale_revision') {
        setConflict(true)
      } else {
        setError(errorMessage(saveError, 'Could not save this revision.'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={variantStyles.editor} onSubmit={save} aria-label="Edit variant">
      {conflict && (
        <div className={styles.conflict} role="alert">
          <p>
            {newerLoaded
              ? `Revision ${variant.current?.revisionNumber ?? ''} is now the latest. Your draft is unchanged — saving now makes it the next revision.`
              : 'Someone saved a newer revision while you were editing. Your draft is still here and nothing was lost.'}
          </p>
          {!newerLoaded && (
            <button type="button" className={styles.secondaryBtn} onClick={onReload}>
              Load the latest revision
            </button>
          )}
        </div>
      )}

      {conflict && newerLoaded && variant.current && (
        <details className={variantStyles.latest} open>
          <summary>Latest saved text (revision {variant.current.revisionNumber})</summary>
          <p className={variantStyles.preText}>{variant.current.body}</p>
        </details>
      )}

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-body`}>
          Body
        </label>
        <textarea
          id={`${id}-body`}
          className={styles.textarea}
          rows={7}
          value={draft.body}
          aria-describedby={`${id}-body-count`}
          onChange={(event) => set('body', event.target.value)}
        />
        <span id={`${id}-body-count`} className={styles.fieldHint}>
          {draft.body.length} characters
        </span>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.field} htmlFor={`${id}-cta`}>
          <span className={styles.label}>Call to action</span>
          <input id={`${id}-cta`} className={styles.input} value={draft.callToAction} onChange={(event) => set('callToAction', event.target.value)} />
        </label>
        <label className={styles.field} htmlFor={`${id}-link`}>
          <span className={styles.label}>Link</span>
          <input
            id={`${id}-link`}
            type="url"
            className={styles.input}
            value={draft.linkUrl}
            placeholder="https://"
            aria-invalid={Boolean(linkError)}
            onChange={(event) => set('linkUrl', event.target.value)}
          />
          {linkError && <span className={styles.fieldError}>{linkError}</span>}
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`} htmlFor={`${id}-tags`}>
          <span className={styles.label}>Hashtags</span>
          <input
            id={`${id}-tags`}
            className={styles.input}
            value={draft.hashtags}
            placeholder="#workshops #smallbusiness"
            onChange={(event) => set('hashtags', event.target.value)}
          />
        </label>
      </div>

      {isEmail && (
        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>Email fields</legend>
          <div className={styles.formGrid}>
            {EMAIL_FIELDS.map((field) => (
              <label key={field.key} className={`${styles.field} ${field.multiline ? styles.fieldWide : ''}`} htmlFor={`${id}-${field.key}`}>
                <span className={styles.label}>{field.label}</span>
                {field.multiline ? (
                  <textarea
                    id={`${id}-${field.key}`}
                    className={styles.textarea}
                    rows={3}
                    value={draft.fields[field.key] ?? ''}
                    onChange={(event) => setField(field.key, event.target.value)}
                  />
                ) : (
                  <input
                    id={`${id}-${field.key}`}
                    className={styles.input}
                    value={draft.fields[field.key] ?? ''}
                    onChange={(event) => setField(field.key, event.target.value)}
                  />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <AssetSelection assets={assets} value={draft.assets} onChange={(refs) => set('assets', refs)} />

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <p className={styles.fieldHint}>Saving creates a new revision. It will need review again before it can be published.</p>
      <div className={styles.formActions}>
        <button type="button" className={styles.secondaryBtn} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={styles.primaryBtn} disabled={busy}>
          {busy ? 'Saving…' : 'Save revision'}
        </button>
      </div>
    </form>
  )
}

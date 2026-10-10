'use client'

import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import type { BrandProfile, ContentBrief, ContentChannel, ContentItem, GenerateRequest } from '@/lib/content-studio/types'

import { createItem, errorMessage, generate } from './api'
import { useIdempotencyKey } from './hooks'
import { parseHttpsUrl } from './labels'
import ChannelSelector from './ChannelSelector'
import { useResource } from './hooks'
import styles from './ContentStudio.module.css'

const MAX_TITLE = 200
const MAX_FACTS = 20
type StylesPerChannel = NonNullable<GenerateRequest['stylesPerChannel']>
const STYLE_OPTIONS: StylesPerChannel[] = [1, 2, 3]

async function readBrand(): Promise<BrandProfile> {
  const response = await fetch('/api/content-studio/brand', { cache: 'no-store' })
  if (!response.ok) throw new Error('Brand profile unavailable')
  const body = await response.json()
  return body.brand as BrandProfile
}

export type BriefDraft = {
  title: string
  topic: string
  audience: string
  objective: string
  referenceUrl: string
  notes: string
  sourceFacts: string[]
  channels: ContentChannel[]
  stylesPerChannel: StylesPerChannel
}

export const EMPTY_BRIEF: BriefDraft = {
  title: '',
  topic: '',
  audience: '',
  objective: '',
  referenceUrl: '',
  notes: '',
  sourceFacts: [],
  channels: ['facebook', 'linkedin'],
  stylesPerChannel: 1,
}

export type BriefErrors = Partial<Record<'title' | 'topic' | 'referenceUrl' | 'channels', string>>

export function validateBrief(draft: BriefDraft): BriefErrors {
  const errors: BriefErrors = {}
  if (!draft.title.trim()) errors.title = 'Give the piece a title.'
  else if (draft.title.trim().length > MAX_TITLE) errors.title = `Keep the title under ${MAX_TITLE} characters.`
  if (!draft.topic.trim()) errors.topic = 'Say what the content is about.'
  if (draft.referenceUrl.trim() && !parseHttpsUrl(draft.referenceUrl)) {
    errors.referenceUrl = 'Use a full https:// address.'
  }
  if (draft.channels.length === 0) errors.channels = 'Pick at least one channel.'
  return errors
}

function optional(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function toBrief(draft: BriefDraft): ContentBrief {
  const facts = draft.sourceFacts.map((fact) => fact.trim()).filter((fact) => fact.length > 0)
  return {
    topic: draft.topic.trim(),
    audience: optional(draft.audience),
    objective: optional(draft.objective),
    notes: optional(draft.notes),
    referenceUrl: optional(draft.referenceUrl),
    sourceFacts: facts.length > 0 ? facts : undefined,
  }
}

type BriefFormProps = {
  /** The item exists and generation was queued (or the operator chose to open it anyway). */
  onCreated: (item: ContentItem) => void
}

/**
 * The brief. Creating is two requests — the item, then its generation — and they fail
 * separately: once the item exists it is never created again, and retrying the
 * generation reuses the same idempotency key so it cannot queue twice.
 */
export default function BriefForm({ onCreated }: BriefFormProps) {
  const [draft, setDraft] = useState<BriefDraft>(EMPTY_BRIEF)
  const [errors, setErrors] = useState<BriefErrors>({})
  const [created, setCreated] = useState<ContentItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { keyFor, settle } = useIdempotencyKey()
  const formId = useId()
  const supportingRef = useRef<HTMLDetailsElement>(null)
  const brand = useResource(readBrand)

  const update = <K extends keyof BriefDraft>(key: K, value: BriefDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }))

  const startGeneration = async (item: ContentItem) => {
    const channels = item.channels.length > 0 ? item.channels : draft.channels
    const idempotencyKey = keyFor(`generate:${item.id}`)
    await generate(item.id, { idempotencyKey, channels, stylesPerChannel: draft.stylesPerChannel })
    settle()
    setCreated(null)
    setDraft(EMPTY_BRIEF)
    onCreated(item)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const found = validateBrief(draft)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      if (found.referenceUrl && supportingRef.current) supportingRef.current.open = true
      const first = found.title ? `${formId}-name` : found.topic ? `${formId}-topic` : found.referenceUrl ? `${formId}-reference` : null
      if (first) document.getElementById(first)?.focus()
      return
    }

    setBusy(true)
    setError(null)
    let item = created
    try {
      if (!item) {
        item = await createItem({ title: draft.title.trim(), brief: toBrief(draft), channels: draft.channels })
        setCreated(item)
      }
      await startGeneration(item)
    } catch (submitError) {
      setError(
        item
          ? `The item was saved, but generation did not start: ${errorMessage(submitError, 'unknown error')}`
          : errorMessage(submitError, 'Could not create the item.')
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={styles.briefShell} onSubmit={submit} noValidate aria-labelledby={`${formId}-title`}>
      <div className={styles.briefPanel}>
        <h2 id={`${formId}-title`} className={styles.panelTitle}>
          New content brief
        </h2>
        <p className={styles.panelHint}>
          Text is generated per channel from this brief and the brand&apos;s approved facts. Images are added
          separately, once the item exists.
        </p>

        {created && (
          <p className={styles.warningNote} role="status">
            “{created.title}” is saved, so the brief is locked here. Retry the generation, or open the item.
          </p>
        )}
        {/* Once the item exists the brief is not sent again; locking it keeps what
            is on screen equal to what was saved. */}
        <fieldset className={styles.fieldset} disabled={created !== null}>
          <legend className={styles.visuallyHidden}>Brief</legend>
          <div className={styles.briefGrid}>
          <div className={styles.briefMain}>
            <TextField id={`${formId}-topic`} label="Topic" value={draft.topic} error={errors.topic} required multiline onChange={(value) => update('topic', value)} wide />
            <TextField id={`${formId}-name`} label="Title" value={draft.title} error={errors.title} required onChange={(value) => update('title', value)} />
            <div className={styles.formGrid}>
              <TextField id={`${formId}-audience`} label="Audience" value={draft.audience} onChange={(value) => update('audience', value)} placeholder="e.g. Small business owners in NSW" />
            <TextField id={`${formId}-objective`} label="Objective" value={draft.objective} onChange={(value) => update('objective', value)} placeholder="e.g. Book a discovery call" />
            </div>
            <details ref={supportingRef} className={styles.supportingDetails}>
              <summary>Supporting context <span>References, notes and source facts</span></summary>
              <div className={styles.supportingFields}>
                <TextField id={`${formId}-reference`} label="Reference URL" value={draft.referenceUrl} error={errors.referenceUrl} onChange={(value) => update('referenceUrl', value)} placeholder="https://" type="url" />
                <TextField id={`${formId}-notes`} label="Notes" value={draft.notes} multiline onChange={(value) => update('notes', value)} wide />
                <FactList facts={draft.sourceFacts} onChange={(facts) => update('sourceFacts', facts)} />
              </div>
            </details>
          </div>
          <aside className={styles.briefOptions} aria-label="Content destinations and options">
            <ChannelSelector value={draft.channels} onChange={(channels) => update('channels', channels)} error={errors.channels} />
            <fieldset className={styles.variantsPicker}>
              <legend>Variants per channel</legend>
              <div>
                {STYLE_OPTIONS.map((count) => <label key={count} className={draft.stylesPerChannel === count ? styles.variantsActive : undefined}>
                  <input type="radio" name={`${formId}-styles`} checked={draft.stylesPerChannel === count} onChange={() => update('stylesPerChannel', count)} />{count}
                </label>)}
              </div>
            </fieldset>
            <div className={styles.briefSummary}><strong>{draft.channels.length} {draft.channels.length === 1 ? 'channel' : 'channels'} · {draft.channels.length * draft.stylesPerChannel} variants</strong><span>Generated drafts are reviewed before publishing.</span></div>
            {brand.data && <div className={styles.brandContext}>
              <strong>{brand.data.name}</strong>
              <span>{brand.data.region}{brand.data.tone ? ` · ${brand.data.tone}` : ''}</span>
              <small>Brand context used for new generations</small>
            </div>}
          </aside>
          </div>
        </fieldset>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        <div className={styles.formActions}>
          {created && (
            <button type="button" className={styles.secondaryBtn} onClick={() => onCreated(created)} disabled={busy}>
              Open the item without generating
            </button>
          )}
          <button type="submit" className={styles.primaryBtn} disabled={busy}>
            {busy ? 'Starting…' : created ? 'Retry generation' : 'Create and generate'}
          </button>
        </div>
      </div>
    </form>
  )
}

type TextFieldProps = {
  id: string
  label: string
  value: string
  error?: string
  required?: boolean
  multiline?: boolean
  wide?: boolean
  placeholder?: string
  type?: 'text' | 'url'
  onChange: (value: string) => void
}

function TextField({ id, label, value, error, required, multiline, wide, placeholder, type = 'text', onChange }: TextFieldProps) {
  const errorId = `${id}-error`
  const common = {
    id,
    value,
    placeholder,
    'aria-invalid': Boolean(error),
    'aria-describedby': error ? errorId : undefined,
    'aria-required': required,
  }
  return (
    <div className={`${styles.field} ${wide ? styles.fieldWide : ''}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {multiline ? (
        <textarea {...common} className={styles.textarea} rows={3} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input {...common} type={type} className={styles.input} onChange={(event) => onChange(event.target.value)} />
      )}
      {error && (
        <p id={errorId} className={styles.fieldError}>
          {error}
        </p>
      )}
    </div>
  )
}

function FactList({ facts, onChange }: { facts: string[]; onChange: (facts: string[]) => void }) {
  const [pending, setPending] = useState('')
  const inputId = useId()

  const add = () => {
    const fact = pending.trim()
    if (!fact || facts.length >= MAX_FACTS) return
    onChange([...facts, fact])
    setPending('')
  }

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        Source facts
      </label>
      <p className={styles.fieldHint}>Facts you vouch for. The generator may state these; it should not invent others.</p>
      {facts.length > 0 && (
        <ul className={styles.factList}>
          {facts.map((fact, index) => (
            <li key={`${index}-${fact}`} className={styles.factItem}>
              <span>{fact}</span>
              <button
                type="button"
                className={styles.linkBtn}
                aria-label={`Remove fact: ${fact}`}
                onClick={() => onChange(facts.filter((_, position) => position !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.inlineRow}>
        <input
          id={inputId}
          className={styles.input}
          value={pending}
          placeholder="e.g. Workshops run every second Tuesday"
          onChange={(event) => setPending(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
        />
        <button type="button" className={styles.secondaryBtn} onClick={add} disabled={!pending.trim() || facts.length >= MAX_FACTS}>
          Add fact
        </button>
      </div>
    </div>
  )
}

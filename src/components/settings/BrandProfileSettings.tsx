'use client'

import React, { useCallback, useEffect, useId, useState } from 'react'

import type { ApprovedFact, BrandProfile, ContentChannel } from '@/lib/content-studio/types'
import { CONTENT_CHANNELS } from '@/lib/content-studio/types'

import styles from './CatalogSettings.module.css'

/**
 * Settings > Brand profile: the voice, approved facts, per-channel calls to action,
 * hashtag seeds, image direction and allowed link origins the Content Studio generator
 * is grounded in. Every member can read it; only an administrator can change it (the API
 * says which with `canEdit`, and the database enforces it again).
 */

const CHANNEL_NAMES: Record<ContentChannel, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  email: 'Email',
}

export type BrandDraft = {
  name: string
  tone: string
  audience: string
  region: string
  imageDirection: string
  approvedFacts: ApprovedFact[]
  channelRules: Record<ContentChannel, { cta: string; structure: string }>
  hashtagSeeds: string
  allowedLinkOrigins: string
}

type Load =
  | { state: 'loading' }
  | { state: 'disabled' }
  | { state: 'error'; message: string }
  | { state: 'ready'; canEdit: boolean }

type Message = { kind: 'error' | 'success'; text: string } | null

export function toDraft(brand: BrandProfile): BrandDraft {
  return {
    name: brand.name,
    tone: brand.tone,
    audience: brand.audience,
    region: brand.region,
    imageDirection: brand.imageDirection,
    approvedFacts: brand.approvedFacts,
    channelRules: Object.fromEntries(
      CONTENT_CHANNELS.map((channel) => [
        channel,
        { cta: brand.channelRules[channel]?.cta ?? '', structure: brand.channelRules[channel]?.structure ?? '' },
      ])
    ) as BrandDraft['channelRules'],
    hashtagSeeds: brand.hashtagSeeds.map((tag) => `#${tag}`).join(' '),
    allowedLinkOrigins: brand.allowedLinkOrigins.join('\n'),
  }
}

const splitList = (value: string, separator: RegExp) =>
  value
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

/** The PATCH body: every field, normalised; empty channel rules are left out. */
export function toUpdate(draft: BrandDraft): Record<string, unknown> {
  const channelRules = Object.fromEntries(
    CONTENT_CHANNELS.flatMap((channel) => {
      const { cta, structure } = draft.channelRules[channel]
      if (!cta.trim() && !structure.trim()) return []
      return [[channel, { ...(cta.trim() ? { cta: cta.trim() } : {}), ...(structure.trim() ? { structure: structure.trim() } : {}) }]]
    })
  )

  return {
    name: draft.name.trim(),
    tone: draft.tone.trim(),
    audience: draft.audience.trim(),
    region: draft.region.trim(),
    imageDirection: draft.imageDirection.trim(),
    approvedFacts: draft.approvedFacts
      .filter((fact) => fact.text.trim() !== '')
      .map((fact) => ({ id: fact.id, text: fact.text.trim(), ...(fact.source?.trim() ? { source: fact.source.trim() } : {}) })),
    channelRules,
    hashtagSeeds: splitList(draft.hashtagSeeds, /[\s,]+/).map((tag) => tag.replace(/^#+/, '')).filter(Boolean),
    allowedLinkOrigins: splitList(draft.allowedLinkOrigins, /[\s,]+/),
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

function useBrand() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [draft, setDraft] = useState<BrandDraft | null>(null)

  const fetchBrand = useCallback(async () => {
    try {
      const response = await fetch('/api/content-studio/brand')
      const body = await readJson(response)
      if (response.status === 404 && body.code === 'feature_disabled') return setLoad({ state: 'disabled' })
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
      setDraft(toDraft(body.brand as BrandProfile))
      setLoad({ state: 'ready', canEdit: body.canEdit === true })
    } catch (error) {
      setLoad({ state: 'error', message: error instanceof Error ? error.message : 'Could not load the brand profile.' })
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchBrand()
  }, [fetchBrand])

  return { load, draft, setDraft, reload: fetchBrand }
}

export default function BrandProfileSettings() {
  const { load, draft, setDraft, reload } = useBrand()
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Message>(null)

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!draft) return
    setSaving(true)
    setMessage(null)
    try {
      const response = await fetch('/api/content-studio/brand', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toUpdate(draft)),
      })
      const body = await readJson(response)
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Save failed (HTTP ${response.status})`)
      setDraft(toDraft(body.brand as BrandProfile))
      setMessage({ kind: 'success', text: 'Brand profile saved. New generations use it from now on.' })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="outerShell" aria-labelledby="brand-profile-title">
      <div className={`innerCore ${styles.card}`}>
        <h3 id="brand-profile-title" className={styles.title}>
          Brand profile
        </h3>
        <p className={styles.intro}>
          The Content Studio writes in this voice and may only state the approved facts below as true.
        </p>
        {load.state === 'loading' && <p role="status" className={styles.intro}>Loading the brand profile…</p>}
        {load.state === 'disabled' && <p className={styles.intro}>The Content Studio is not enabled in this deployment.</p>}
        {load.state === 'error' && (
          <p role="alert" className={styles.error}>
            {load.message}{' '}
            <button type="button" className={styles.linkBtn} onClick={() => void reload()}>
              Try again
            </button>
          </p>
        )}
        {load.state === 'ready' && draft && (
          <BrandForm draft={draft} canEdit={load.canEdit} saving={saving} message={message} onChange={setDraft} onSubmit={save} />
        )}
      </div>
    </section>
  )
}

type FormProps = {
  draft: BrandDraft
  canEdit: boolean
  saving: boolean
  message: Message
  onChange: (draft: BrandDraft) => void
  onSubmit: (event: React.FormEvent) => void
}

function BrandForm({ draft, canEdit, saving, message, onChange, onSubmit }: FormProps) {
  const set = <K extends keyof BrandDraft>(key: K, value: BrandDraft[K]) => onChange({ ...draft, [key]: value })

  return (
    <form onSubmit={onSubmit} aria-label="Brand profile">
      {!canEdit && (
        <p className={styles.intro} data-testid="brand-read-only">
          Only an administrator can change the brand profile.
        </p>
      )}
      <fieldset disabled={!canEdit || saving} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-md)' }}>
        <div className={styles.toolbar}>
          <Field label="Brand name" value={draft.name} onChange={(value) => set('name', value)} />
          <Field label="Region" value={draft.region} onChange={(value) => set('region', value)} />
        </div>
        <Field label="Tone of voice" value={draft.tone} multiline onChange={(value) => set('tone', value)} />
        <Field label="Audience" value={draft.audience} multiline onChange={(value) => set('audience', value)} />
        <FactsEditor facts={draft.approvedFacts} onChange={(facts) => set('approvedFacts', facts)} />
        <ChannelRulesEditor rules={draft.channelRules} onChange={(rules) => set('channelRules', rules)} />
        <Field
          label="Hashtag seeds"
          hint="Separate with spaces or commas. The generator starts from these."
          value={draft.hashtagSeeds}
          onChange={(value) => set('hashtagSeeds', value)}
        />
        <Field label="Image direction" value={draft.imageDirection} multiline onChange={(value) => set('imageDirection', value)} />
        <Field
          label="Allowed link origins"
          hint="One per line, like https://ai4l.example — no path. A generated link outside these is blocked until a person edits it."
          value={draft.allowedLinkOrigins}
          multiline
          onChange={(value) => set('allowedLinkOrigins', value)}
        />
      </fieldset>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? styles.error : styles.success}>
          {message.text}
        </p>
      )}
      {canEdit && (
        <button type="submit" className={styles.primaryBtn} disabled={saving}>
          {saving ? 'Saving…' : 'Save brand profile'}
        </button>
      )}
    </form>
  )
}

type FieldProps = { label: string; value: string; hint?: string; multiline?: boolean; onChange: (value: string) => void }

function Field({ label, value, hint, multiline, onChange }: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const common = { id, value, className: styles.input, 'aria-describedby': hint ? hintId : undefined }

  return (
    <div className={styles.fieldGroup}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea {...common} rows={3} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input {...common} type="text" onChange={(event) => onChange(event.target.value)} />
      )}
      {hint && (
        <span id={hintId} className={styles.intro} style={{ margin: 0 }}>
          {hint}
        </span>
      )}
    </div>
  )
}

function FactsEditor({ facts, onChange }: { facts: ApprovedFact[]; onChange: (facts: ApprovedFact[]) => void }) {
  const update = (index: number, patch: Partial<ApprovedFact>) =>
    onChange(facts.map((fact, position) => (position === index ? { ...fact, ...patch } : fact)))

  return (
    <fieldset className={styles.fieldGroup} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className={styles.label}>Approved facts</legend>
      <span className={styles.intro} style={{ margin: 0 }}>
        Statements the generator may make. Anything else it must not invent.
      </span>
      {facts.length === 0 && <p className={styles.empty}>No approved facts yet.</p>}
      <ul className={styles.list}>
        {facts.map((fact, index) => (
          <li key={fact.id} className={styles.row}>
            <div className={styles.toolbar} style={{ flex: 1, marginBottom: 0 }}>
              <Field label={`Fact ${index + 1}`} value={fact.text} onChange={(text) => update(index, { text })} />
              <Field label={`Source of fact ${index + 1}`} value={fact.source ?? ''} onChange={(source) => update(index, { source })} />
            </div>
            <button
              type="button"
              className={styles.linkBtn}
              aria-label={`Remove fact ${index + 1}`}
              onClick={() => onChange(facts.filter((_, position) => position !== index))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={styles.secondaryBtn}
        disabled={facts.length >= 100}
        onClick={() => onChange([...facts, { id: `fact-${Date.now().toString(36)}-${facts.length + 1}`, text: '' }])}
      >
        Add fact
      </button>
    </fieldset>
  )
}

type RulesProps = { rules: BrandDraft['channelRules']; onChange: (rules: BrandDraft['channelRules']) => void }

function ChannelRulesEditor({ rules, onChange }: RulesProps) {
  return (
    <fieldset className={styles.fieldGroup} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className={styles.label}>Per-channel rules</legend>
      {CONTENT_CHANNELS.map((channel) => (
        <div key={channel} className={styles.toolbar} style={{ marginBottom: 0 }}>
          <Field
            label={`${CHANNEL_NAMES[channel]} call to action`}
            value={rules[channel].cta}
            onChange={(cta) => onChange({ ...rules, [channel]: { ...rules[channel], cta } })}
          />
          <Field
            label={`${CHANNEL_NAMES[channel]} structure`}
            value={rules[channel].structure}
            onChange={(structure) => onChange({ ...rules, [channel]: { ...rules[channel], structure } })}
          />
        </div>
      ))}
    </fieldset>
  )
}

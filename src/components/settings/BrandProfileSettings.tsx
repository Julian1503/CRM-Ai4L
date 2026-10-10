'use client'

import React, { useCallback, useEffect, useId, useState } from 'react'

import type { ApprovedFact, BrandProfile, ContentChannel } from '@/lib/content-studio/types'
import { CONTENT_CHANNELS } from '@/lib/content-studio/types'

import styles from './CatalogSettings.module.css'
import brandStyles from './BrandProfileSettings.module.css'

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
  const [savedDraft, setSavedDraft] = useState<BrandDraft | null>(null)

  const fetchBrand = useCallback(async () => {
    try {
      const response = await fetch('/api/content-studio/brand')
      const body = await readJson(response)
      if (response.status === 404 && body.code === 'feature_disabled') return setLoad({ state: 'disabled' })
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
      const next = toDraft(body.brand as BrandProfile)
      setDraft(next)
      setSavedDraft(next)
      setLoad({ state: 'ready', canEdit: body.canEdit === true })
    } catch (error) {
      setLoad({ state: 'error', message: error instanceof Error ? error.message : 'Could not load the brand profile.' })
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchBrand()
  }, [fetchBrand])

  return { load, draft, savedDraft, setDraft, setSavedDraft, reload: fetchBrand }
}

export default function BrandProfileSettings({ onDirtyChange, compact = false }: { onDirtyChange?: (dirty: boolean) => void; compact?: boolean } = {}) {
  const { load, draft, savedDraft, setDraft, setSavedDraft, reload } = useBrand()
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  const changed = draft !== null && savedDraft !== null && JSON.stringify(draft) !== JSON.stringify(savedDraft)

  useEffect(() => { onDirtyChange?.(changed) }, [changed, onDirtyChange])

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
      const next = toDraft(body.brand as BrandProfile)
      setDraft(next)
      setSavedDraft(next)
      setMessage({ kind: 'success', text: 'Brand profile saved. New generations use it from now on.' })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={compact ? brandStyles.compact : 'outerShell'} aria-label={compact ? 'Brand profile editor' : undefined} aria-labelledby={compact ? undefined : 'brand-profile-title'}>
      <div className={compact ? styles.card : `innerCore ${styles.card}`}>
        {!compact && <h3 id="brand-profile-title" className={brandStyles.heading}>
          Brand profile
        </h3>}
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
          <BrandForm draft={draft} savedDraft={savedDraft} canEdit={load.canEdit} saving={saving} message={message} onChange={setDraft} onSubmit={save} onDiscard={() => { if (savedDraft) setDraft(savedDraft); setMessage(null) }} />
        )}
      </div>
    </section>
  )
}

type FormProps = {
  draft: BrandDraft
  savedDraft: BrandDraft | null
  canEdit: boolean
  saving: boolean
  message: Message
  onChange: (draft: BrandDraft) => void
  onSubmit: (event: React.FormEvent) => void
  onDiscard: () => void
}

type BrandTab = 'voice' | 'facts' | 'rules' | 'visuals'
const BRAND_TABS: { id: BrandTab; label: string }[] = [
  { id: 'voice', label: 'Voice & audience' },
  { id: 'facts', label: 'Approved facts' },
  { id: 'rules', label: 'Channel rules' },
  { id: 'visuals', label: 'Visuals & links' },
]

function BrandForm({ draft, savedDraft, canEdit, saving, message, onChange, onSubmit, onDiscard }: FormProps) {
  const set = <K extends keyof BrandDraft>(key: K, value: BrandDraft[K]) => onChange({ ...draft, [key]: value })
  const [tab, setTab] = useState<BrandTab>('voice')
  const [channel, setChannel] = useState<ContentChannel>('facebook')
  const changed = savedDraft !== null && JSON.stringify(draft) !== JSON.stringify(savedDraft)

  const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? BRAND_TABS[0] : BRAND_TABS[BRAND_TABS.length - 1]
      setTab(next.id)
      document.getElementById(`brand-tab-${next.id}`)?.focus()
      return
    }
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const next = BRAND_TABS[(index + delta + BRAND_TABS.length) % BRAND_TABS.length]
    setTab(next.id)
    document.getElementById(`brand-tab-${next.id}`)?.focus()
  }

  return (
    <form className={brandStyles.form} onSubmit={onSubmit} aria-label="Brand profile">
      {!canEdit && (
        <p className={styles.intro} data-testid="brand-read-only">
          Only an administrator can change the brand profile.
        </p>
      )}
      <div className={brandStyles.tabs} role="tablist" aria-label="Brand profile sections">
        {BRAND_TABS.map((item, index) => (
          <button key={item.id} id={`brand-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls="brand-panel" tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? brandStyles.tabActive : undefined} onClick={() => setTab(item.id)} onKeyDown={(event) => onTabKey(event, index)}>
            {item.label}
          </button>
        ))}
      </div>
      <div id="brand-panel" role="tabpanel" aria-labelledby={`brand-tab-${tab}`} className={brandStyles.panel}>
        <fieldset disabled={!canEdit || saving} className={brandStyles.fields}>
          {tab === 'voice' && <>
            <div className={styles.toolbar}>
              <Field label="Brand name" value={draft.name} onChange={(value) => set('name', value)} />
              <Field label="Region" value={draft.region} onChange={(value) => set('region', value)} />
            </div>
            <Field label="Tone of voice" value={draft.tone} multiline onChange={(value) => set('tone', value)} />
            <Field label="Audience" value={draft.audience} multiline onChange={(value) => set('audience', value)} />
          </>}
          {tab === 'facts' && <FactsEditor facts={draft.approvedFacts} onChange={(facts) => set('approvedFacts', facts)} />}
          {tab === 'rules' && <>
            <div className={brandStyles.channelNav} aria-label="Channel rules">
              {CONTENT_CHANNELS.map((item) => <button key={item} type="button" aria-pressed={channel === item} onClick={() => setChannel(item)}>{CHANNEL_NAMES[item]}</button>)}
            </div>
            <ChannelRulesEditor channel={channel} rules={draft.channelRules} onChange={(rules) => set('channelRules', rules)} />
            <Field label="Hashtag seeds" hint="Separate with spaces or commas. Used across channels." value={draft.hashtagSeeds} onChange={(value) => set('hashtagSeeds', value)} />
          </>}
          {tab === 'visuals' && <>
            <Field label="Image direction" value={draft.imageDirection} multiline onChange={(value) => set('imageDirection', value)} />
            <Field label="Allowed link origins" hint="One https:// origin per line. Links outside this list need human editing." value={draft.allowedLinkOrigins} multiline onChange={(value) => set('allowedLinkOrigins', value)} />
          </>}
        </fieldset>
      </div>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? styles.error : styles.success}>
          {message.text}
        </p>
      )}
      {canEdit && <div className={brandStyles.saveBar}>
        <span>{changed ? 'Unsaved changes' : 'All changes saved'}</span>
        <div>
          {changed && <button type="button" className={styles.secondaryBtn} disabled={saving} onClick={onDiscard}>Discard</button>}
          <button type="submit" className={styles.primaryBtn} disabled={saving || !changed}>{saving ? 'Saving…' : 'Save brand profile'}</button>
        </div>
      </div>}
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
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = facts.find((fact) => fact.id === activeId)
  const activeIndex = active ? facts.indexOf(active) : -1
  const update = (index: number, patch: Partial<ApprovedFact>) =>
    onChange(facts.map((fact, position) => (position === index ? { ...fact, ...patch } : fact)))

  return (
    <fieldset className={styles.fieldGroup} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className={styles.label}>Approved facts</legend>
      <span className={styles.intro} style={{ margin: 0 }}>
        Statements the generator may make. Anything else it must not invent.
      </span>
      {facts.length === 0 && <p className={styles.empty}>No approved facts yet.</p>}
      <ul className={brandStyles.factsList}>
        {facts.map((fact, index) => (
          <li key={fact.id}>
            <button type="button" aria-pressed={activeId === fact.id} onClick={() => setActiveId(fact.id)}>
              <strong>Fact {index + 1}</strong><span>{fact.text || 'New fact'}</span>
            </button>
          </li>
        ))}
      </ul>
      {active && <div className={brandStyles.factEditor}>
        <Field label={`Fact ${activeIndex + 1}`} value={active.text} onChange={(text) => update(activeIndex, { text })} />
        <Field label={`Source of fact ${activeIndex + 1}`} value={active.source ?? ''} onChange={(source) => update(activeIndex, { source })} />
        <button type="button" className={styles.linkBtn} onClick={() => { onChange(facts.filter((fact) => fact.id !== active.id)); setActiveId(null) }}>Remove fact</button>
      </div>}
      <button
        type="button"
        className={styles.secondaryBtn}
        disabled={facts.length >= 100}
        onClick={() => { const id = `fact-${Date.now().toString(36)}-${facts.length + 1}`; onChange([...facts, { id, text: '' }]); setActiveId(id) }}
      >
        Add fact
      </button>
    </fieldset>
  )
}

type RulesProps = { channel: ContentChannel; rules: BrandDraft['channelRules']; onChange: (rules: BrandDraft['channelRules']) => void }

function ChannelRulesEditor({ channel, rules, onChange }: RulesProps) {
  return (
    <fieldset className={styles.fieldGroup} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className={styles.label}>Per-channel rules</legend>
        <div className={styles.toolbar} style={{ marginBottom: 0 }}>
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
    </fieldset>
  )
}

'use client'

import React, { useMemo, useState } from 'react'

import { CAMPAIGN_COPY_FIELDS, type CampaignCopyField } from '@/lib/marketing/mergeFields'

import styles from './marketing.module.css'

/**
 * The human gate on generated copy, laid out as the email it becomes.
 *
 * Requirement 3.3 says nothing sends without approval, and approval is meaningless if
 * the reviewer cannot see what they are approving. Seven labelled boxes in a grid made
 * that hard: judging a headline against its preview line, or three benefits against
 * each other, meant reassembling the message in your head first.
 *
 * So the fields sit where they land — headline on the subject line, preheader on the
 * inbox preview line, intro and benefits and button in the body. It is a *composer*,
 * not a preview: the real template lives in EmailOctopus and we do not have it, so
 * nothing here claims to be a picture of the delivered email. Type, spacing and colour
 * are this app's, not the template's. What the layout does claim is the *order and
 * role* of each merge field, which is exactly what a reviewer needs and what a grid of
 * boxes hid.
 */

export type CampaignCopyEditorProps = {
  campaignId: string
  campaignName: string
  /** Locked once the campaign is past review; copy must not change under an approval. */
  editable: boolean
  mergeFields: Record<string, string>
  /** Who the email is addressed to, shown on the To line. The segment's name. */
  audienceLabel?: string
  /**
   * How many contacts that segment currently matches, once counted.
   *
   * `undefined` means not counted yet, which is not the same as zero: the generate
   * route refuses an empty audience with a 409, so zero disables the button here
   * rather than letting the operator discover it from a banner after clicking.
   */
  audienceSize?: number
  /**
   * Reports what the server stored. The status travels with it because generating
   * copy can move a campaign back to draft, and the caller must not have to guess
   * which of its own actions did that.
   */
  /** The revision on screen; a save over a newer one is refused (audit H6). */
  revision?: number
  onSaved: (mergeFields: Record<string, string>, status?: string, revision?: number) => void
  onError: (message: string) => void
}

/** Merge tags the composer places by hand; anything else falls through to the tail. */
const SLOTTED_TAGS = [
  'Headline',
  'Preheader',
  'Intro',
  'Benefit1',
  'Benefit2',
  'Benefit3',
  'CtaLabel',
] as const

const audienceCount = new Intl.NumberFormat('en-AU')

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

export default function CampaignCopyEditor({
  campaignId,
  campaignName,
  editable,
  mergeFields,
  revision,
  audienceLabel,
  audienceSize,
  onSaved,
  onError,
}: CampaignCopyEditorProps) {
  const [draft, setDraft] = useState<Record<string, string>>(mergeFields)
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)

  const overruns = useMemo(
    () =>
      CAMPAIGN_COPY_FIELDS.filter(
        (field) => (draft[field.tag] ?? '').trim().length > field.maxLength
      ).map((field) => field.tag),
    [draft]
  )

  const empties = useMemo(
    () =>
      CAMPAIGN_COPY_FIELDS.filter((field) => !(draft[field.tag] ?? '').trim()).map(
        (field) => field.tag
      ),
    [draft]
  )

  const hasCopy = empties.length === 0
  const canSave = editable && hasCopy && overruns.length === 0 && busy === null

  // Only a counted zero blocks; an uncounted audience is not assumed empty.
  const audienceIsEmpty = audienceSize === 0
  const canGenerate = editable && !audienceIsEmpty && busy === null

  /**
   * Fields the hand-placed slots did not claim.
   *
   * The slots are written out by tag, so a field added to the contract later would have
   * no home. Rather than disappear from the only screen that can edit it, it lands in a
   * plain list under the message.
   */
  const unslotted = CAMPAIGN_COPY_FIELDS.filter(
    (field) => !SLOTTED_TAGS.includes(field.tag as (typeof SLOTTED_TAGS)[number])
  )

  const generate = async () => {
    onError('')
    setBusy('generate')

    try {
      const response = await fetch('/api/campaigns/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId }),
      })

      if (!response.ok) throw new Error(await readError(response))

      const body = await response.json()
      const copy = (body.campaign?.merge_fields ?? {}) as Record<string, string>

      setDraft(copy)
      setGeneratedAt(
        `Written for ${body.audience?.size ?? 0} contacts` +
          (body.generation?.attempts > 1 ? ` (${body.generation.attempts} attempts)` : '')
      )
      onSaved(copy, body.campaign?.status, body.campaign?.revision)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not generate copy.')
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    onError('')
    setBusy('save')

    try {
      const trimmed: Record<string, string> = {}
      for (const field of CAMPAIGN_COPY_FIELDS) {
        trimmed[field.tag] = (draft[field.tag] ?? '').trim()
      }

      const response = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mergeFields: trimmed,
          ...(revision !== undefined ? { expectedRevision: revision } : {}),
        }),
      })

      if (!response.ok) throw new Error(await readError(response))

      const body = await response.json().catch(() => ({}))

      setDraft(trimmed)
      setGeneratedAt(null)
      onSaved(trimmed, body.campaign?.status, body.campaign?.revision)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not save copy.')
    } finally {
      setBusy(null)
    }
  }

  const fieldByTag = new Map(CAMPAIGN_COPY_FIELDS.map((field) => [field.tag, field]))

  /**
   * One editable slot.
   *
   * The control carries `aria-label` rather than a visible caption, because in the
   * body the caption *is* the position: a screen reader still hears "Opening
   * paragraph", while a sighted reviewer reads the message instead of a form.
   *
   * The wrapper, not the textarea, carries the typography and the box. It renders the
   * current value a second time as a hidden replica in the same grid cell, so the
   * field is exactly as tall as its content — a fixed `rows` left a paragraph-sized
   * hole under every short line and a scrollbar inside every long one.
   */
  const slot = (
    tag: string,
    className: string,
    wrapSlot?: (slot: React.ReactNode) => React.ReactNode
  ) => {
    const field = fieldByTag.get(tag)
    if (!field) return null

    return renderField(field, className, wrapSlot)
  }

  const renderField = (
    field: CampaignCopyField,
    className: string,
    /** Wraps the field alone, so a slot can sit inside a button without its meta. */
    wrapSlot?: (slot: React.ReactNode) => React.ReactNode
  ) => {
    const value = draft[field.tag] ?? ''
    const length = value.trim().length
    const over = length > field.maxLength
    const inputId = `copy-${campaignId}-${field.tag}`

    const control = (
      <span
        className={`${styles.grow} ${className}`}
        // Sizes the field. Falls back to the placeholder so an empty slot still
        // occupies the one line it will show.
        data-replicate={value || field.label}
      >
        <textarea
          id={inputId}
          className={styles.slotInput}
          rows={1}
          value={value}
          disabled={!editable}
          aria-label={field.label}
          aria-invalid={over || undefined}
          aria-describedby={`${inputId}-count`}
          placeholder={editable ? field.label : undefined}
          onChange={(event) =>
            setDraft((current) => ({ ...current, [field.tag]: event.target.value }))
          }
          data-testid={`copy-field-${field.tag}`}
        />
      </span>
    )

    return (
      <>
        {wrapSlot ? wrapSlot(control) : control}
        <span className={over ? styles.slotMetaOver : styles.slotMeta}>
          <span className={styles.tag}>{`{{${field.tag}}}`}</span>
          <span
            id={`${inputId}-count`}
            className={over ? styles.countOver : styles.count}
            data-testid={`copy-count-${field.tag}`}
          >
            {length} / {field.maxLength}
            {over ? ' — too long for the template' : ''}
          </span>
        </span>
      </>
    )
  }

  return (
    <div className={styles.copyEditor} data-testid="campaign-copy-editor">
      <div className={styles.composerBar}>
        <div>
          <h3 className={styles.copyTitle}>Campaign email</h3>
          <span className={styles.composerSub}>{campaignName}</span>
        </div>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={generate}
          disabled={!canGenerate}
          data-testid="generate-copy"
        >
          {busy === 'generate' ? 'Writing…' : hasCopy ? 'Rewrite with AI' : 'Write with AI'}
        </button>
      </div>

      <div className={styles.envelope}>
        <div className={styles.envelopeRow}>
          <span className={styles.envelopeLabel}>To</span>
          <span className={styles.envelopeTo} data-testid="composer-audience">
            {audienceLabel || 'the campaign segment'}
            {audienceSize !== undefined &&
              ` · ${audienceCount.format(audienceSize)} contact${audienceSize === 1 ? '' : 's'}`}
          </span>
        </div>

        <div className={styles.envelopeRow} data-testid="composer-subject">
          <span className={styles.envelopeLabel}>Subject</span>
          <div className={styles.envelopeField}>{slot('Headline', styles.subjectSlot)}</div>
        </div>

        <div className={styles.envelopeRow} data-testid="composer-preview">
          <span className={styles.envelopeLabel}>Preview</span>
          <div className={styles.envelopeField}>{slot('Preheader', styles.previewSlot)}</div>
        </div>
      </div>

      {audienceIsEmpty && (
        <p className={styles.emptyAudience} data-testid="empty-audience">
          This segment matches no contacts right now, so there is no audience to write
          for. Widen the segment&apos;s filters, or point the campaign at another
          segment.
        </p>
      )}

      <div className={styles.sheet} data-testid="composer-body">
        <div className={styles.sheetBlock}>{slot('Intro', styles.introSlot)}</div>

        <ul className={styles.benefits}>
          {['Benefit1', 'Benefit2', 'Benefit3'].map((tag) => (
            <li className={styles.benefit} key={tag} data-testid="composer-benefit">
              <span className={styles.benefitMark} aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              <div className={styles.benefitField}>{slot(tag, styles.benefitSlot)}</div>
            </li>
          ))}
        </ul>

        <div className={styles.ctaBlock}>
          {slot('CtaLabel', styles.ctaSlot, (control) => (
            <span className={styles.ctaButton}>{control}</span>
          ))}
          <p className={styles.ctaNote} data-testid="composer-cta-note">
            The booking link behind this button is generated per recipient when the
            campaign sends, so it is not written here.
          </p>
        </div>

        {unslotted.length > 0 && (
          <div className={styles.sheetBlock}>
            {unslotted.map((field) => (
              <div className={styles.extraField} key={field.tag}>
                {renderField(field, styles.introSlot)}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.composerFooter}>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={save}
          disabled={!canSave}
          data-testid="save-copy"
        >
          {busy === 'save' ? 'Saving…' : 'Save copy'}
        </button>

        {!hasCopy && (
          <span className={styles.itemMeta} data-testid="copy-incomplete">
            {empties.length} field{empties.length === 1 ? '' : 's'} still empty.
          </span>
        )}

        {generatedAt && (
          <span className={styles.copyMeta} data-testid="generation-meta">
            {generatedAt}
          </span>
        )}

        {!editable && (
          <span className={styles.copyMeta} data-testid="copy-locked">
            This campaign is past review, so its copy is locked. Move it back to draft to
            change it.
          </span>
        )}
      </div>
    </div>
  )
}

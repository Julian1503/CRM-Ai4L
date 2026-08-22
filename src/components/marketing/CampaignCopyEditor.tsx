'use client'

import React, { useMemo, useState } from 'react'

import { CAMPAIGN_COPY_FIELDS } from '@/lib/marketing/mergeFields'

import styles from './marketing.module.css'

/**
 * The human gate on generated copy.
 *
 * Requirement 3.3 says nothing sends without approval, and approval is meaningless if
 * the reviewer cannot see what they are approving. This is that screen: every merge
 * field the template will receive, editable, with its character budget visible while
 * you type rather than discovered on save.
 *
 * It deliberately does not preview the email. The template lives in EmailOctopus and we
 * do not have it — a mocked-up preview would be a picture of an email that does not
 * exist, which is worse than no preview at all.
 */

export type CampaignCopyEditorProps = {
  campaignId: string
  campaignName: string
  /** Locked once the campaign is past review; copy must not change under an approval. */
  editable: boolean
  mergeFields: Record<string, string>
  /**
   * Reports what the server stored. The status travels with it because generating
   * copy can move a campaign back to draft, and the caller must not have to guess
   * which of its own actions did that.
   */
  onSaved: (mergeFields: Record<string, string>, status?: string) => void
  onError: (message: string) => void
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

export default function CampaignCopyEditor({
  campaignId,
  campaignName,
  editable,
  mergeFields,
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
      onSaved(copy, body.campaign?.status)
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
        body: JSON.stringify({ mergeFields: trimmed }),
      })

      if (!response.ok) throw new Error(await readError(response))

      const body = await response.json().catch(() => ({}))

      setDraft(trimmed)
      setGeneratedAt(null)
      onSaved(trimmed, body.campaign?.status)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not save copy.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={styles.copyEditor} data-testid="campaign-copy-editor">
      <div className={styles.copyHeader}>
        <h3 className={styles.copyTitle}>Copy for {campaignName}</h3>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={generate}
          disabled={!editable || busy !== null}
          data-testid="generate-copy"
        >
          {busy === 'generate' ? 'Writing…' : hasCopy ? 'Rewrite with AI' : 'Write with AI'}
        </button>
      </div>

      <p className={styles.panelHint}>
        These values are merged into the EmailOctopus template by tag. Each one has a
        hard limit because it lands in a fixed layout. The booking link is not here — it
        is generated per recipient when the campaign sends.
      </p>

      {generatedAt && (
        <p className={styles.copyMeta} data-testid="generation-meta">
          {generatedAt}
        </p>
      )}

      {!editable && (
        <p className={styles.copyMeta} data-testid="copy-locked">
          This campaign is past review, so its copy is locked. Move it back to draft to
          change it.
        </p>
      )}

      <div className={styles.copyFields}>
        {CAMPAIGN_COPY_FIELDS.map((field) => {
          const value = draft[field.tag] ?? ''
          const length = value.trim().length
          const over = length > field.maxLength
          const inputId = `copy-${campaignId}-${field.tag}`

          return (
            <label className={styles.field} key={field.tag} htmlFor={inputId}>
              <span className={styles.label}>
                {field.label}
                <span className={styles.tag}> {`{{${field.tag}}}`}</span>
              </span>
              <textarea
                id={inputId}
                className={styles.input}
                rows={field.maxLength > 200 ? 4 : 2}
                value={value}
                disabled={!editable}
                aria-invalid={over || undefined}
                aria-describedby={`${inputId}-count`}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [field.tag]: event.target.value }))
                }
                data-testid={`copy-field-${field.tag}`}
              />
              <span
                id={`${inputId}-count`}
                className={over ? styles.countOver : styles.count}
                data-testid={`copy-count-${field.tag}`}
              >
                {length} / {field.maxLength}
                {over ? ' — too long for the template' : ''}
              </span>
            </label>
          )
        })}
      </div>

      <div className={styles.actions}>
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
      </div>
    </div>
  )
}

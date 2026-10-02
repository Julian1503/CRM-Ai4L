'use client'

import { useState } from 'react'

import type { ContentAsset, ContentRevision, ContentVariant } from '@/lib/content-studio/types'
import ConfirmDialog from '@/components/ui/ConfirmDialog'

import { ApiError, duplicateVariant, errorMessage, generate, reviewRevision, setVariantArchived } from './api'
import { composePostText } from './composePostText'
import { useIdempotencyKey } from './hooks'
import { REVIEW_LABELS, REVIEW_TONES, formatDateTime, isSocialChannel } from './labels'
import PromptDialog from './PromptDialog'
import { previewImages } from './revision'
import SocialPreview from './SocialPreview'
import { ChannelTag, StatusPill } from './StatusPill'
import VariantEditor, { EMAIL_FIELDS } from './VariantEditor'
import styles from './ContentStudio.module.css'
import jobStyles from './Jobs.module.css'
import mediaStyles from './Media.module.css'
import variantStyles from './Variant.module.css'

type Busy = 'approve' | 'reject' | 'regenerate' | 'duplicate' | 'archive' | null
type Prompt = 'reject' | 'regenerate' | 'archive' | null

export type VariantCardProps = {
  itemId: string
  variant: ContentVariant
  assets: ContentAsset[]
  /** The variant or item changed on the server: reload. */
  onChanged: () => void
  onPublish?: (variant: ContentVariant) => void
  /** Reserved for the email wave; the button stays disabled until this is wired. */
  onCreateEmail?: (variantId: string, revisionId: string) => void
}

const ORIGIN_LABELS: Record<ContentRevision['origin'], string> = {
  generated: 'generated',
  regenerated: 'regenerated',
  edited: 'edited',
  duplicated: 'duplicated',
}

/** Guidance for the refusals the operator can act on; anything else keeps the server's words. */
export function describeActionError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    // The server's message carries the reason (which claim or phrase was blocked).
    if (error.code === 'blocked_content') return `Edit this text before approving: ${error.message}`
    if (error.code === 'archived') return 'This variant or its item is archived. Restore the item before changing it.'
    if (error.code === 'stale_revision') return 'A newer revision exists. Reload the item and review the latest one.'
  }
  return errorMessage(error, fallback)
}

/**
 * One variant: its current revision, review state and the actions on it. Approval
 * belongs to a revision, so any edit produces a new revision that starts pending.
 */
export default function VariantCard({ itemId, variant, assets, onChanged, onPublish, onCreateEmail }: VariantCardProps) {
  const [editing, setEditing] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [prompt, setPrompt] = useState<Prompt>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const regenerateKey = useIdempotencyKey()
  const duplicateKey = useIdempotencyKey()

  const revision = variant.current
  const social = isSocialChannel(variant.channel)

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>, fallback: string) => {
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      await action()
      setPrompt(null)
      onChanged()
    } catch (actionError) {
      setError(describeActionError(actionError, fallback))
    } finally {
      setBusy(null)
    }
  }

  const review = (decision: 'approved' | 'rejected', reason?: string) => {
    if (!revision) return
    void run(
      decision === 'approved' ? 'approve' : 'reject',
      () => reviewRevision(variant.id, { revisionId: revision.id, decision, reason }),
      'Could not record the review.'
    )
  }

  const regenerate = (instruction: string) =>
    void run(
      'regenerate',
      async () => {
        const request = {
          channels: [variant.channel],
          variantId: variant.id,
          baseRevisionId: revision?.id,
          instruction: instruction || undefined,
        }
        await generate(itemId, { ...request, idempotencyKey: regenerateKey.keyFor(JSON.stringify(request)) })
        regenerateKey.settle()
      },
      'Could not start regeneration.'
    )

  const duplicate = () =>
    void run(
      'duplicate',
      async () => {
        await duplicateVariant(variant.id, { idempotencyKey: duplicateKey.keyFor(variant.currentRevisionId ?? variant.id) })
        duplicateKey.settle()
      },
      'Could not duplicate this variant.'
    )

  const archive = () => void run('archive', () => setVariantArchived(variant.id, true), 'Could not archive this variant.')

  const copy = async () => {
    if (!revision) return
    try {
      await navigator.clipboard.writeText(composePostText(revision))
      setNotice('Copied to the clipboard.')
    } catch {
      setError('Could not copy to the clipboard.')
    }
  }

  return (
    <article className={variantStyles.variantCard} aria-label={`${variant.channel} variant, style ${variant.style}`} data-testid={`variant-${variant.id}`}>
      <header className={variantStyles.variantHead}>
        <ChannelTag channel={variant.channel} />
        <span className={variantStyles.variantStyle}>{variant.style}</span>
        {revision ? (
          <>
            <StatusPill tone={REVIEW_TONES[revision.review]}>{REVIEW_LABELS[revision.review]}</StatusPill>
            <span className={styles.muted}>
              Revision {revision.revisionNumber} · {ORIGIN_LABELS[revision.origin]} {formatDateTime(revision.createdAt)}
            </span>
          </>
        ) : (
          <span className={styles.muted}>No revision yet</span>
        )}
      </header>

      {variant.conflictOfRevisionId && (
        <p className={styles.warningNote}>A late generation result was kept as a separate variant so it did not overwrite an edit.</p>
      )}

      {revision?.review === 'rejected' && revision.reviewReason && (
        <p className={styles.inlineError}>Rejected: {revision.reviewReason}</p>
      )}

      {revision && revision.violations.length > 0 && (
        <ul className={jobStyles.violations} aria-label="Validation notes">
          {revision.violations.map((violation) => (
            <li key={violation}>{violation}</li>
          ))}
        </ul>
      )}

      {editing ? (
        <VariantEditor
          variant={variant}
          assets={assets}
          onReload={onChanged}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            onChanged()
          }}
        />
      ) : (
        revision && <RevisionBody revision={revision} isEmail={variant.channel === 'email'} assets={assets} />
      )}

      {previewing && revision && isSocialChannel(variant.channel) && (
        <SocialPreview platform={variant.channel} text={composePostText(revision)} images={previewImages(revision.assets, assets)} />
      )}

      {error && (
        <p className={styles.inlineError} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.muted} role="status">
          {notice}
        </p>
      )}

      {!editing && (
        <div className={styles.cardActions}>
          {revision && revision.review !== 'approved' && (
            <button type="button" className={styles.primaryBtn} disabled={busy !== null} onClick={() => review('approved')}>
              {busy === 'approve' ? 'Approving…' : `Approve revision ${revision.revisionNumber}`}
            </button>
          )}
          {revision && social && revision.review === 'approved' && onPublish && (
            <button type="button" className={styles.primaryBtn} onClick={() => onPublish(variant)}>
              Publish…
            </button>
          )}
          {revision && revision.review !== 'rejected' && (
            <button type="button" className={styles.secondaryBtn} disabled={busy !== null} onClick={() => setPrompt('reject')}>
              Reject
            </button>
          )}
          {revision && (
            <button type="button" className={styles.secondaryBtn} onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {revision && social && (
            <button type="button" className={styles.secondaryBtn} aria-pressed={previewing} onClick={() => setPreviewing((value) => !value)}>
              {previewing ? 'Hide preview' : 'Preview'}
            </button>
          )}
          <button type="button" className={styles.secondaryBtn} disabled={busy !== null} onClick={() => setPrompt('regenerate')}>
            Regenerate
          </button>
          {revision && (
            <>
              <button type="button" className={styles.secondaryBtn} disabled={busy !== null} onClick={duplicate}>
                {busy === 'duplicate' ? 'Duplicating…' : 'Duplicate'}
              </button>
              <button type="button" className={styles.secondaryBtn} onClick={copy}>
                Copy text
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={!onCreateEmail}
                title={onCreateEmail ? undefined : 'Email creation arrives in a later release.'}
                onClick={() => onCreateEmail?.(variant.id, revision.id)}
              >
                Create email
              </button>
            </>
          )}
          <button type="button" className={styles.linkBtn} disabled={busy !== null} onClick={() => setPrompt('archive')}>
            Archive
          </button>
        </div>
      )}

      {prompt === 'reject' && (
        <PromptDialog
          title="Reject this revision?"
          hint="The reason is kept with the revision so whoever edits it next knows what to fix."
          label="Reason"
          placeholder="e.g. The workshop date is wrong"
          confirmLabel="Reject revision"
          required
          busy={busy === 'reject'}
          error={error}
          onSubmit={(reason) => review('rejected', reason)}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'regenerate' && (
        <PromptDialog
          title="Regenerate this variant"
          hint="A new revision is generated from the current one. The current text stays in history."
          label="Instruction"
          placeholder="e.g. Shorter, and lead with the date"
          confirmLabel="Regenerate"
          busy={busy === 'regenerate'}
          error={error}
          onSubmit={regenerate}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'archive' && (
        <ConfirmDialog
          title="Archive this variant?"
          subject={`${variant.channel} · ${variant.style}`}
          confirmLabel="Archive"
          busy={busy === 'archive'}
          error={error}
          onConfirm={archive}
          onClose={() => setPrompt(null)}
        >
          <p>It leaves this item. Its revisions and any publications stay on record.</p>
        </ConfirmDialog>
      )}
    </article>
  )
}

function RevisionBody({ revision, isEmail, assets }: { revision: ContentRevision; isEmail: boolean; assets: ContentAsset[] }) {
  const images = previewImages(revision.assets, assets)
  return (
    <div className={variantStyles.revisionBody}>
      {isEmail && (
        <dl className={styles.fieldList}>
          {EMAIL_FIELDS.filter((field) => revision.fields[field.key]).map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd>{revision.fields[field.key]}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className={variantStyles.preText}>{revision.body}</p>
      {revision.callToAction && (
        <p className={variantStyles.revisionMeta}>
          <strong>CTA:</strong> {revision.callToAction}
        </p>
      )}
      {revision.linkUrl && (
        <p className={variantStyles.revisionMeta}>
          <strong>Link:</strong>{' '}
          <a href={revision.linkUrl} target="_blank" rel="noopener noreferrer">
            {revision.linkUrl}
          </a>
        </p>
      )}
      {revision.hashtags.length > 0 && <p className={variantStyles.hashtags}>{revision.hashtags.join(' ')}</p>}
      {images.length > 0 && (
        <ol className={mediaStyles.thumbRow} aria-label="Images in posting order">
          {images.map((image) => (
            <li key={image.id}>
              {image.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={mediaStyles.thumb} src={image.url} alt={image.alt} loading="lazy" />
              ) : (
                <span className={mediaStyles.thumbEmpty} role="img" aria-label={image.alt || 'Image'} />
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

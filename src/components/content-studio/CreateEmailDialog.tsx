'use client'

import { useEffect, useMemo, useState } from 'react'

import { EmailRenderError, renderEmail } from '@/lib/content-studio/emailRenderer'
import { EMAIL_LIMITS, type EmailDraftFields } from '@/lib/content-studio/toEmailCampaign'
import { contentPublicPrefix, findContract, STUDIO_CONTRACTS, type CtaMode } from '@/lib/marketing/templateContracts'

import Dialog from './Dialog'
import previewStyles from './EmailPreview.module.css'
import EmailPreview from './EmailPreview'
import { useIdempotencyKey } from './hooks'
import styles from './ContentStudio.module.css'

/**
 * Turns an approved-or-not post into an email: a DRAFT campaign (with its own approval
 * still to come in Campaigns) or an HTML export. The server re-validates everything
 * against the template contract, publishes the images and records an immutable snapshot.
 */

type ProposalAsset = { assetId: string; alt: string; previewUrl: string | null; width: number | null; height: number | null; ready: boolean }

export type EmailProposal = {
  variantId: string
  itemId: string
  itemTitle: string
  revisionId: string
  adaptation: { subject: string; fields: EmailDraftFields; ctaUrl: string | null; ctaMode: CtaMode; notes: string[] }
  assets: ProposalAsset[]
}

type TemplateOption = { id: string; name: string; contract_id?: string; contract_version?: number; archived_at: string | null }
type SegmentOption = { id: string; name: string }

type CreateEmailDialogProps = {
  variantId: string
  onClose: () => void
  /** Called with the new draft campaign, so the caller can open it in Campaigns. */
  onCreated?: (campaignId: string) => void
}

const FIELD_ROWS: { key: keyof EmailDraftFields; label: string; limit: number; multiline?: boolean }[] = [
  { key: 'Preheader', label: 'Inbox preview text', limit: EMAIL_LIMITS.preheader },
  { key: 'Headline', label: 'Headline', limit: EMAIL_LIMITS.headline },
  { key: 'Intro', label: 'Opening paragraph', limit: EMAIL_LIMITS.intro, multiline: true },
  { key: 'Body', label: 'Body', limit: EMAIL_LIMITS.body, multiline: true },
  { key: 'CtaLabel', label: 'Button label', limit: EMAIL_LIMITS.ctaLabel },
]

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.')
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : `Request failed (HTTP ${response.status})`)
  return body as T
}

function post<T>(url: string, body: unknown): Promise<T> {
  return call<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

function download(filename: string, html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export default function CreateEmailDialog({ variantId, onClose, onCreated }: CreateEmailDialogProps) {
  const [proposal, setProposal] = useState<EmailProposal | null>(null)
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [segments, setSegments] = useState<SegmentOption[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'draft' | 'export' | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const [templateId, setTemplateId] = useState('')
  const [segmentId, setSegmentId] = useState('')
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [fields, setFields] = useState<EmailDraftFields>({ Preheader: '', Headline: '', Intro: '', Body: '', CtaLabel: '' })
  const [ctaMode, setCtaMode] = useState<CtaMode>('none')
  const [ctaUrl, setCtaUrl] = useState('')
  const [imageId, setImageId] = useState('')
  const [alt, setAlt] = useState('')
  // A key per action and payload: retrying the same click reuses it (the server dedupes),
  // while any edit is a new request that gets a new key — an edited re-export must never
  // come back as the first export's stored HTML.
  const draftKeys = useIdempotencyKey()
  const exportKeys = useIdempotencyKey()

  useEffect(() => {
    let cancelled = false
    Promise.all([
      call<{ proposal: EmailProposal }>(`/api/content-studio/variants/${variantId}/email-draft`),
      call<{ templates: TemplateOption[] }>('/api/templates'),
      call<{ segments: SegmentOption[] }>('/api/segments?pageSize=200'),
    ])
      .then(([loaded, templateList, segmentList]) => {
        if (cancelled) return
        const { adaptation } = loaded.proposal
        setProposal(loaded.proposal)
        // Only active templates on a Studio contract this CRM knows (unknown ones are hidden).
        setTemplates(
          (templateList.templates ?? []).filter((t) => {
            const known = findContract(t.contract_id, t.contract_version ?? 1)
            return !t.archived_at && known !== null && known.delivery !== 'legacy'
          })
        )
        setSegments(segmentList.segments ?? [])
        setName(loaded.proposal.itemTitle ? `${loaded.proposal.itemTitle} (email)` : 'Studio email')
        setSubject(adaptation.subject)
        setFields(adaptation.fields)
        setCtaMode(adaptation.ctaMode)
        setCtaUrl(adaptation.ctaUrl ?? '')
        const firstReady = loaded.proposal.assets.find((asset) => asset.ready)
        if (firstReady) {
          setImageId(firstReady.assetId)
          setAlt(firstReady.alt)
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setLoadError(reason instanceof Error ? reason.message : 'Could not prepare the email.')
      })
    return () => {
      cancelled = true
    }
  }, [variantId])

  const template = templates.find((option) => option.id === templateId)
  const contract = template ? findContract(template.contract_id, template.contract_version ?? 1) : null
  const allowedModes: CtaMode[] = contract ? [...contract.ctaModes] : ['external_url', 'none']
  const image = proposal?.assets.find((asset) => asset.assetId === imageId) ?? null

  const preview = useMemo(() => {
    const input = {
      subject,
      preheader: fields.Preheader,
      headline: fields.Headline,
      intro: fields.Intro,
      body: fields.Body,
      ctaMode,
      ctaLabel: fields.CtaLabel,
      ctaUrl: ctaMode === 'external_url' ? ctaUrl : null,
      image: image?.previewUrl ? { url: image.previewUrl, alt, width: image.width ?? 0, height: image.height ?? 0 } : null,
    }
    const options = { imagePrefix: contentPublicPrefix(), previewImageUrls: image?.previewUrl ? [image.previewUrl] : [] }
    try {
      return { html: renderEmail(input, options).html, off: renderEmail(input, { ...options, blockImages: true }).html, problem: null }
    } catch (renderError) {
      return { html: '', off: '', problem: renderError instanceof EmailRenderError ? renderError.message : 'Preview unavailable.' }
    }
  }, [subject, fields, ctaMode, ctaUrl, image, alt])

  const payload = () => ({
    revisionId: proposal?.revisionId,
    subject,
    fields,
    ctaMode,
    ctaUrl: ctaMode === 'external_url' ? ctaUrl.trim() : null,
    assets: imageId ? [{ assetId: imageId, alt }] : [],
  })

  const createDraft = async () => {
    setError(null)
    setBusy('draft')
    try {
      const request = { ...payload(), templateId, segmentId: segmentId || null, campaignName: name }
      const result = await post<{ campaignId: string }>(`/api/content-studio/variants/${variantId}/email-draft`, {
        ...request,
        idempotencyKey: draftKeys.keyFor(JSON.stringify(request)),
      })
      setDone('Draft campaign created. Review and approve it in Campaigns before anything is sent.')
      onCreated?.(result.campaignId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the draft.')
    } finally {
      setBusy(null)
    }
  }

  const exportHtml = async () => {
    setError(null)
    setBusy('export')
    try {
      const request = payload()
      const result = await post<{ html: string; text: string }>(`/api/content-studio/variants/${variantId}/email-export`, {
        ...request,
        idempotencyKey: exportKeys.keyFor(JSON.stringify(request)),
      })
      download(`${(proposal?.itemTitle || 'email').replace(/[^\w-]+/g, '-').slice(0, 60)}.html`, result.html)
      await navigator.clipboard?.writeText(result.text).catch(() => undefined)
      setDone('HTML downloaded and the plain-text version copied. An export is not a delivery: nothing was sent.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not export the email.')
    } finally {
      setBusy(null)
    }
  }

  const canSubmit = Boolean(proposal) && busy === null && !preview.problem && subject.trim() !== ''
  const footer = (
    <>
      <button type="button" className={styles.secondaryBtn} onClick={onClose} disabled={busy !== null}>
        Close
      </button>
      <button type="button" className={styles.secondaryBtn} onClick={exportHtml} disabled={!canSubmit || ctaMode === 'booking'}>
        {busy === 'export' ? 'Exporting…' : 'Export HTML'}
      </button>
      <button type="button" className={styles.primaryBtn} onClick={createDraft} disabled={!canSubmit || !templateId || !name.trim()}>
        {busy === 'draft' ? 'Creating…' : 'Create draft campaign'}
      </button>
    </>
  )

  return (
    <Dialog title="Create email" hint="Adapt this post into an email, then create a draft campaign or export the HTML." wide busy={busy !== null} onClose={onClose} footer={footer}>
      <p className={previewStyles.approvalNote}>
        Approving a post does not authorise sending an email. The draft still needs its own approval in Campaigns.
      </p>
      {loadError && <p className={styles.error} role="alert">{loadError}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {done && <p className={styles.muted} role="status">{done}</p>}
      {!proposal && !loadError && <p className={styles.muted}>Preparing the email…</p>}
      {proposal && (
        <div className={previewStyles.dialogGrid}>
          <div className={styles.formGrid}>
            {proposal.adaptation.notes.map((note) => (
              <p key={note} className={styles.fieldHint}>{note}</p>
            ))}
            <label className={styles.fieldWide}>
              <span className={styles.label}>Template</span>
              <select className={styles.select} value={templateId} onChange={(event) => {
                setTemplateId(event.target.value)
                const picked = templates.find((t) => t.id === event.target.value)
                const next = picked ? findContract(picked.contract_id, picked.contract_version ?? 1) : null
                if (next && !next.ctaModes.includes(ctaMode)) setCtaMode(next.ctaModes[0])
              }}>
                <option value="">Choose a Studio template…</option>
                {templates.map((option) => (
                  <option key={option.id} value={option.id}>{option.name} ({option.contract_id})</option>
                ))}
              </select>
              {templates.length === 0 && (
                <span className={styles.fieldHint}>
                  No Studio template is registered. Register one ({STUDIO_CONTRACTS.map((c) => c.id).join(' or ')}) in Email templates, or export the HTML.
                </span>
              )}
            </label>
            <label className={styles.fieldWide}>
              <span className={styles.label}>Segment</span>
              <select className={styles.select} value={segmentId} onChange={(event) => setSegmentId(event.target.value)}>
                <option value="">Choose later</option>
                {segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
              </select>
            </label>
            <label className={styles.fieldWide}>
              <span className={styles.label}>Campaign name</span>
              <input className={styles.input} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className={styles.fieldWide}>
              <span className={styles.label}>Subject ({subject.length}/{EMAIL_LIMITS.subject})</span>
              <input className={styles.input} value={subject} aria-invalid={subject.length > EMAIL_LIMITS.subject} onChange={(event) => setSubject(event.target.value)} />
            </label>
            {FIELD_ROWS.filter((row) => row.key !== 'CtaLabel' || ctaMode !== 'none').map((row) => {
              const value = fields[row.key]
              const props = {
                className: row.multiline ? styles.textarea : styles.input,
                value,
                'aria-invalid': value.length > row.limit,
                onChange: (event: { target: { value: string } }) => setFields((current) => ({ ...current, [row.key]: event.target.value })),
              }
              return (
                <label key={row.key} className={styles.fieldWide}>
                  <span className={styles.label}>{row.label} ({value.length}/{row.limit})</span>
                  {row.multiline ? <textarea rows={row.key === 'Body' ? 6 : 3} {...props} /> : <input {...props} />}
                </label>
              )
            })}
            <label className={styles.fieldWide}>
              <span className={styles.label}>Button</span>
              <select className={styles.select} value={ctaMode} onChange={(event) => setCtaMode(event.target.value as CtaMode)}>
                {allowedModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === 'external_url' ? 'Link to a page' : mode === 'none' ? 'No button' : 'Book a consultation (per-recipient link)'}
                  </option>
                ))}
              </select>
            </label>
            {ctaMode === 'external_url' && (
              <label className={styles.fieldWide}>
                <span className={styles.label}>Button link (https)</span>
                <input className={styles.input} type="url" value={ctaUrl} onChange={(event) => setCtaUrl(event.target.value)} />
              </label>
            )}
            <fieldset className={styles.fieldset}>
              <legend className={styles.label}>Image</legend>
              <label className={styles.check}>
                <input type="radio" name="email-image" checked={imageId === ''} onChange={() => setImageId('')} /> No image
              </label>
              {proposal.assets.map((asset) => (
                <label key={asset.assetId} className={previewStyles.imageChoice}>
                  <input type="radio" name="email-image" disabled={!asset.ready} checked={imageId === asset.assetId} onChange={() => {
                    setImageId(asset.assetId)
                    setAlt(asset.alt)
                  }} />
                  {/* Short-lived signed previews; next/image cannot optimise them. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {asset.previewUrl ? <img className={previewStyles.thumb} src={asset.previewUrl} alt={asset.alt} /> : <span className={styles.muted}>Not ready</span>}
                </label>
              ))}
              {imageId && (
                <label className={styles.fieldWide}>
                  <span className={styles.label}>Image description (alt text)</span>
                  <input className={styles.input} value={alt} maxLength={200} onChange={(event) => setAlt(event.target.value)} />
                </label>
              )}
            </fieldset>
          </div>
          <div>
            {preview.problem ? (
              <p className={styles.warningNote}>{preview.problem}</p>
            ) : (
              <EmailPreview html={preview.html} htmlImagesOff={preview.off} title="Email preview" />
            )}
          </div>
        </div>
      )}
    </Dialog>
  )
}

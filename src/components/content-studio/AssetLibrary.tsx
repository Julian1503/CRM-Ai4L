'use client'

import { useId, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'

import type { ContentAsset, ContentJob, GenerateImagesRequest } from '@/lib/content-studio/types'

import { ApiError, createUpload, errorMessage, generateImages, ingestAsset, uploadToSignedUrl } from './api'
import { AssetThumb } from './AssetSelection'
import { useIdempotencyKey } from './hooks'
import JobStatusLine from './JobStatusLine'
import { INGEST_LABELS, INGEST_TONES } from './labels'
import { assetLabel } from './revision'
import { StatusPill } from './StatusPill'
import styles from './ContentStudio.module.css'
import jobStyles from './Jobs.module.css'
import mediaStyles from './Media.module.css'

/** What the picker offers. The server checks the real bytes; these are hints. */
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const COUNTS: GenerateImagesRequest['count'][] = [1, 2, 3, 4]

export function checkFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return `${file.name} is not a JPEG, PNG or WebP image.`
  if (file.size > MAX_UPLOAD_BYTES) return `${file.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`
  if (file.size === 0) return `${file.name} is empty.`
  return null
}

type TrackedJob = { job: ContentJob; label: string; assetId: string | null }

/**
 * A stand-in for a job known only by id (an asset's `activeJobId`). The poller fetches
 * the real thing on its first tick; a non-terminal status is what makes it poll.
 */
export function placeholderJob(id: string, assetId: string): ContentJob {
  return {
    id,
    kind: 'ingest_asset',
    status: 'queued',
    itemId: null,
    variantId: null,
    assetId,
    publicationId: null,
    attempts: 0,
    maxAttempts: 0,
    errorCode: null,
    errorMessage: null,
    cancelRequestedAt: null,
    createdAt: '',
    startedAt: null,
    finishedAt: null,
    failures: [],
    warnings: [],
  }
}

type AssetLibraryProps = {
  itemId: string
  assets: ContentAsset[]
  loading: boolean
  error: unknown
  onReload: () => void
  /** Jobs another panel already follows (the item's own job list), so they are not shown twice. */
  knownJobIds?: string[]
}

/**
 * The item's images. Uploads go browser → Storage with a signed URL, then a worker
 * checks and re-encodes them; generated images arrive the same way. Either path is a
 * background job, followed here until it ends.
 */
export default function AssetLibrary({ itemId, assets, loading, error, onReload, knownJobIds = [] }: AssetLibraryProps) {
  const [jobs, setJobs] = useState<TrackedJob[]>([])
  const [uploadStep, setUploadStep] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const fileId = useId()

  const [reprocessError, setReprocessError] = useState<string | null>(null)

  const track = (job: ContentJob, label: string, assetId: string | null = job.assetId) =>
    setJobs((previous) => [{ job, label, assetId }, ...previous])

  // Pending assets whose processing job is still out there: after a reload or a new
  // visit nothing local knows about it, so follow it from the asset's activeJobId.
  const followed = new Set([...knownJobIds, ...jobs.map((tracked) => tracked.job.id)])
  const trackedAssets = new Set(jobs.map((tracked) => tracked.assetId))
  const pending = assets.filter((asset) => asset.ingestStatus === 'pending' && !asset.archivedAt)
  const resumed: TrackedJob[] = pending
    .filter((asset) => asset.activeJobId && !followed.has(asset.activeJobId))
    .map((asset) => ({ job: placeholderJob(asset.activeJobId as string, asset.id), label: `Processing ${assetLabel(asset)}`, assetId: asset.id }))
  const allJobs = [...jobs, ...resumed]

  const reprocess = async (asset: ContentAsset) => {
    setReprocessError(null)
    try {
      track(await ingestAsset(asset.id), `Processing ${assetLabel(asset)}`, asset.id)
    } catch (failure) {
      setReprocessError(
        failure instanceof ApiError && failure.code === 'asset_not_pending'
          ? `${assetLabel(asset)} has already been processed. Showing its current state.`
          : errorMessage(failure, 'Could not start processing again.')
      )
    } finally {
      onReload()
    }
  }

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const problem = checkFile(file)
    setUploadError(problem)
    if (problem) return

    try {
      setUploadStep('Preparing upload…')
      const { asset, upload: target } = await createUpload({ filename: file.name, mimeType: file.type, byteSize: file.size, itemId })
      setUploadStep(`Uploading ${file.name}…`)
      await uploadToSignedUrl(target.signedUrl, file)
      setUploadStep('Starting processing…')
      const job = await ingestAsset(asset.id)
      track(job, `Processing ${file.name}`)
      onReload()
    } catch (failure) {
      setUploadError(errorMessage(failure, 'The upload failed.'))
    } finally {
      setUploadStep(null)
    }
  }

  return (
    <section className={styles.detailSection} aria-labelledby={`${fileId}-heading`}>
      <div className={styles.panelHead}>
        <h3 id={`${fileId}-heading`} className={styles.sectionTitle}>
          Images
        </h3>
        <div className={styles.actions}>
          <input
            ref={fileRef}
            id={fileId}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            className={styles.visuallyHidden}
            onChange={upload}
            tabIndex={-1}
            aria-hidden="true"
          />
          <button type="button" className={styles.secondaryBtn} onClick={() => fileRef.current?.click()} disabled={uploadStep !== null}>
            Upload image
          </button>
          <button type="button" className={styles.linkBtn} onClick={onReload}>
            Refresh
          </button>
        </div>
      </div>
      <p className={styles.fieldHint}>JPEG, PNG or WebP up to 15 MB. Each file is checked and cleaned of metadata before it can be used.</p>

      {uploadStep && (
        <p className={styles.muted} role="status">
          {uploadStep}
        </p>
      )}
      {uploadError && (
        <p className={styles.inlineError} role="alert">
          {uploadError}
        </p>
      )}

      <ImageGenerateForm itemId={itemId} onStarted={(job, prompt) => track(job, `Generating: ${prompt}`)} />

      {reprocessError && (
        <p className={styles.inlineError} role="alert">
          {reprocessError}
        </p>
      )}

      {allJobs.length > 0 && (
        <ul className={jobStyles.jobList} aria-label="Image jobs">
          {allJobs.map(({ job, label }) => (
            <JobStatusLine key={job.id} job={job} label={label} onSettled={onReload} />
          ))}
        </ul>
      )}

      {Boolean(error) && (
        <p className={styles.error} role="alert">
          {errorMessage(error, 'Could not load images.')}
        </p>
      )}
      {loading && assets.length === 0 && !error && <p className={styles.muted}>Loading images…</p>}
      {!loading && assets.length === 0 && !error && <p className={styles.empty}>No images yet. Upload one or generate some.</p>}

      {assets.length > 0 && (
        <ul className={mediaStyles.assetGrid}>
          {assets.map((asset) => (
            <li key={asset.id} className={mediaStyles.assetCard} data-testid={`asset-${asset.id}`}>
              <AssetThumb asset={asset} />
              <span className={mediaStyles.assetName}>{assetLabel(asset)}</span>
              <span className={styles.tagRow}>
                <StatusPill tone={INGEST_TONES[asset.ingestStatus]}>{INGEST_LABELS[asset.ingestStatus]}</StatusPill>
                <span className={styles.muted}>{asset.origin === 'generated' ? 'Generated' : 'Uploaded'}</span>
              </span>
              {asset.width && asset.height && (
                <span className={styles.muted}>
                  {asset.width}×{asset.height}
                </span>
              )}
              {asset.ingestStatus === 'rejected' && <span className={styles.inlineError}>{asset.rejectionReason ?? 'Rejected without a reason.'}</span>}
              {asset.ingestStatus === 'pending' && !asset.activeJobId && !trackedAssets.has(asset.id) && (
                <>
                  <span className={styles.muted}>Processing stopped before it finished.</span>
                  <button type="button" className={styles.secondaryBtn} onClick={() => reprocess(asset)} aria-label={`Process ${assetLabel(asset)} again`}>
                    Process again
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ImageGenerateForm({ itemId, onStarted }: { itemId: string; onStarted: (job: ContentJob, prompt: string) => void }) {
  const [prompt, setPrompt] = useState('')
  const [count, setCount] = useState<GenerateImagesRequest['count']>(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { keyFor, settle } = useIdempotencyKey()
  const id = useId()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = prompt.trim()
    if (!text) {
      setError('Describe the image you want.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const job = await generateImages(itemId, { idempotencyKey: keyFor(`${text}:${count}`), prompt: text, count })
      settle()
      setPrompt('')
      onStarted(job, text)
    } catch (failure) {
      setError(errorMessage(failure, 'Could not start image generation.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={styles.generateForm} onSubmit={submit} aria-label="Image generation">
      <label className={`${styles.field} ${styles.grow}`} htmlFor={`${id}-prompt`}>
        <span className={styles.label}>Generate images</span>
        <input
          id={`${id}-prompt`}
          className={styles.input}
          value={prompt}
          placeholder="e.g. A bright workshop room with people collaborating"
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <label className={styles.field} htmlFor={`${id}-count`}>
        <span className={styles.label}>How many</span>
        <select id={`${id}-count`} className={styles.select} value={count} onChange={(event) => setCount(Number(event.target.value) as GenerateImagesRequest['count'])}>
          {COUNTS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={styles.secondaryBtn} disabled={busy}>
        {busy ? 'Starting…' : 'Generate'}
      </button>
      {error && (
        <p className={`${styles.fieldError} ${styles.fullRow}`} role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

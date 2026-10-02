'use client'

import { useEffect, useRef } from 'react'

import type { ContentAsset, RevisionAssetRef } from '@/lib/content-studio/types'

import { assetLabel, moveRef, normaliseOrder } from './revision'
import styles from './ContentStudio.module.css'
import mediaStyles from './Media.module.css'

type AssetSelectionProps = {
  assets: ContentAsset[]
  value: RevisionAssetRef[]
  onChange: (refs: RevisionAssetRef[]) => void
  maxImages?: number
}

/**
 * The images on one revision, in the order they will be posted, each with its alt
 * text. Reordering is done with buttons, so it works from the keyboard and with a
 * screen reader; the row keeps its key when it moves, so focus stays on the button.
 */
export default function AssetSelection({ assets, value, onChange, maxImages }: AssetSelectionProps) {
  const selected = normaliseOrder(value)
  const selectedIds = new Set(selected.map((ref) => ref.assetId))
  const available = assets.filter((asset) => !asset.archivedAt && !selectedIds.has(asset.id))
  const full = maxImages !== undefined && selected.length >= maxImages
  const listRef = useRef<HTMLOListElement>(null)
  const pendingFocus = useRef<string | null>(null)

  // After a move, keep focus on the moved row. When it reaches an end, the button just
  // pressed is disabled, so focus goes to the one that still moves it.
  useEffect(() => {
    if (!pendingFocus.current) return
    listRef.current?.querySelector<HTMLButtonElement>(`[data-focus-key="${pendingFocus.current}"]`)?.focus()
    pendingFocus.current = null
  })

  const move = (assetId: string, index: number, delta: -1 | 1) => {
    const target = index + delta
    const atEdge = delta === 1 ? target === selected.length - 1 : target === 0
    pendingFocus.current = `${assetId}:${atEdge ? -delta : delta}`
    onChange(moveRef(selected, assetId, delta))
  }

  const add = (asset: ContentAsset) =>
    onChange([...selected, { assetId: asset.id, alt: asset.altText, order: selected.length }])
  const remove = (assetId: string) => onChange(normaliseOrder(selected.filter((ref) => ref.assetId !== assetId)))
  const setAlt = (assetId: string, alt: string) =>
    onChange(selected.map((ref) => (ref.assetId === assetId ? { ...ref, alt } : ref)))

  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.label}>
        Images{maxImages !== undefined ? ` (${selected.length}/${maxImages})` : ''}
      </legend>

      {selected.length === 0 ? (
        <p className={styles.fieldHint}>No images on this revision.</p>
      ) : (
        <ol ref={listRef} className={mediaStyles.selectionList} aria-label="Selected images in posting order">
          {selected.map((ref, index) => {
            const asset = assets.find((candidate) => candidate.id === ref.assetId)
            const name = asset ? assetLabel(asset) : 'Missing image'
            return (
              <li key={ref.assetId} className={mediaStyles.selectionRow}>
                <span className={mediaStyles.selectionOrder} aria-hidden="true">
                  {index + 1}
                </span>
                <AssetThumb asset={asset} />
                <div className={mediaStyles.selectionMain}>
                  <span className={styles.itemMeta}>{name}</span>
                  <label className={styles.field}>
                    <span className={styles.label}>Alt text</span>
                    <input className={styles.input} value={ref.alt} onChange={(event) => setAlt(ref.assetId, event.target.value)} />
                  </label>
                  {!ref.alt.trim() && <span className={styles.fieldHint}>Describe the image for people who cannot see it.</span>}
                </div>
                <div className={mediaStyles.selectionActions}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label={`Move ${name} up`}
                    data-focus-key={`${ref.assetId}:-1`}
                    disabled={index === 0}
                    onClick={() => move(ref.assetId, index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label={`Move ${name} down`}
                    data-focus-key={`${ref.assetId}:1`}
                    disabled={index === selected.length - 1}
                    onClick={() => move(ref.assetId, index, 1)}
                  >
                    ↓
                  </button>
                  <button type="button" className={styles.linkBtn} aria-label={`Remove ${name}`} onClick={() => remove(ref.assetId)}>
                    Remove
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {available.length > 0 && (
        <ul className={mediaStyles.availableList} aria-label="Images you can add">
          {available.map((asset) => (
            <li key={asset.id} className={mediaStyles.availableItem}>
              <AssetThumb asset={asset} />
              <span className={styles.itemMeta}>{assetLabel(asset)}</span>
              {asset.ingestStatus === 'ready' ? (
                <button type="button" className={styles.secondaryBtn} disabled={full} onClick={() => add(asset)} aria-label={`Add ${assetLabel(asset)}`}>
                  Add
                </button>
              ) : (
                <span className={styles.fieldHint}>
                  {asset.ingestStatus === 'pending' ? 'Still processing' : `Rejected: ${asset.rejectionReason ?? 'no reason given'}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

export function AssetThumb({ asset }: { asset: ContentAsset | undefined }) {
  if (!asset?.previewUrl) return <span className={mediaStyles.thumbEmpty} aria-hidden="true" />
  // Short-lived signed URL from private storage; not a candidate for next/image.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={mediaStyles.thumb} src={asset.previewUrl} alt="" loading="lazy" />
}

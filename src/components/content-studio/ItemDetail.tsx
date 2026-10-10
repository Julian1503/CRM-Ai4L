'use client'

import { useCallback, useState } from 'react'

import type { ContentAsset, ContentChannel, ContentItem, ContentVariant } from '@/lib/content-studio/types'
import { CONTENT_CHANNELS } from '@/lib/content-studio/types'

import { errorMessage, getItem, listAssets, updateItem } from './api'
import AssetLibrary from './AssetLibrary'
import GenerationProgress from './GenerationProgress'
import { useResource } from './hooks'
import { CHANNEL_LABELS, formatDateTime } from './labels'
import PublicationHistory from './PublicationHistory'
import PublishDialog from './PublishDialog'
import { ChannelTag, StatusPill } from './StatusPill'
import VariantCard from './VariantCard'
import styles from './ContentStudio.module.css'

type ItemDetailProps = {
  itemId: string
  onBack: () => void
  onOpenSettings?: () => void
  onCreateEmail?: (variantId: string, revisionId: string) => void
  reviewFocus?: boolean
  onDirtyChange?: (dirty: boolean) => void
  confirmLeave?: () => boolean
}

const ASSET_PAGE_SIZE = 100

export function groupByChannel(variants: ContentVariant[]): { channel: ContentChannel; variants: ContentVariant[] }[] {
  const live = variants.filter((variant) => !variant.archivedAt)
  return CONTENT_CHANNELS.map((channel) => ({
    channel,
    variants: live.filter((variant) => variant.channel === channel).sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
  })).filter((group) => group.variants.length > 0)
}

/** One item: its brief, generation jobs, variants by channel, images and publications. */
export default function ItemDetail({ itemId, onBack, onOpenSettings, onCreateEmail, reviewFocus = false, onDirtyChange, confirmLeave }: ItemDetailProps) {
  const loadItem = useCallback(() => getItem(itemId), [itemId])
  const loadAssets = useCallback(async (): Promise<ContentAsset[]> => (await listAssets({ itemId, pageSize: ASSET_PAGE_SIZE })).assets, [itemId])
  const item = useResource(loadItem)
  const assets = useResource(loadAssets)
  const [publishing, setPublishing] = useState<ContentVariant | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [publicationsVersion, setPublicationsVersion] = useState(0)
  const [requestedChannel, setRequestedChannel] = useState<ContentChannel | null>(() => {
    if (typeof window === 'undefined') return null
    const channel = new URLSearchParams(window.location.search).get('channel')
    return CONTENT_CHANNELS.find((value) => value === channel) ?? null
  })
  const [requestedVariantId, setRequestedVariantId] = useState<string | null>(() => typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('variant'))
  const [detailPanel, setDetailPanel] = useState<'media' | 'history'>('media')

  const reloadAll = useCallback(() => {
    item.reload()
    assets.reload()
  }, [item, assets])

  if (!item.data) {
    return (
      <div className="outerShell">
        <div className={`innerCore ${styles.panel}`}>
          <button type="button" className={styles.backBtn} onClick={onBack}>
            ← All content
          </button>
          {item.error ? (
            <div className={styles.error} role="alert">
              {errorMessage(item.error, 'Could not load this item.')}{' '}
              <button type="button" className={styles.linkBtn} onClick={item.reload}>
                Try again
              </button>
            </div>
          ) : (
            <p className={styles.muted} role="status">
              Loading…
            </p>
          )}
        </div>
      </div>
    )
  }

  const data: ContentItem = item.data
  const assetList = assets.data ?? []
  const groups = groupByChannel(data.variants)
  const activeGroup = groups.find((group) => group.channel === requestedChannel) ?? (reviewFocus ? groups.find((group) => group.variants.some((variant) => variant.current?.review === 'pending')) : undefined) ?? groups[0]
  const activeVariant = activeGroup?.variants.find((variant) => variant.id === requestedVariantId) ?? (reviewFocus ? activeGroup?.variants.find((variant) => variant.current?.review === 'pending') : undefined) ?? activeGroup?.variants[0]

  const chooseVariant = (channel: ContentChannel, variantId: string | null) => {
    if (channel === activeGroup?.channel && (variantId === activeVariant?.id || (variantId === null && requestedVariantId === null))) return
    if (confirmLeave && !confirmLeave()) return
    setRequestedChannel(channel)
    setRequestedVariantId(variantId)
    const url = new URL(window.location.href)
    url.searchParams.set('channel', channel)
    if (variantId) url.searchParams.set('variant', variantId)
    else url.searchParams.delete('variant')
    window.history.replaceState(null, '', url)
  }

  const toggleArchive = async () => {
    setArchiving(true)
    setArchiveError(null)
    try {
      await updateItem(data.id, { archived: !data.archivedAt })
      item.reload()
    } catch (failure) {
      setArchiveError(errorMessage(failure, 'Could not update the item.'))
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="outerShell">
      <div className={`innerCore ${styles.panel} ${styles.detail}`}>
        <button type="button" className={styles.backBtn} onClick={onBack}>
          ← All content
        </button>

        <header className={styles.detailHeader}>
          <div className={styles.detailTitleGroup}>
            <h2 className={styles.detailTitle}>{data.title}</h2>
            <span className={styles.tagRow}>
              {data.channels.map((channel) => (
                <ChannelTag key={channel} channel={channel} />
              ))}
              {data.archivedAt && <StatusPill tone="neutral">Archived</StatusPill>}
              <span className={styles.muted}>Created {formatDateTime(data.createdAt)}</span>
            </span>
          </div>
          <button type="button" className={styles.secondaryBtn} onClick={toggleArchive} disabled={archiving}>
            {data.archivedAt ? 'Restore item' : 'Archive item'}
          </button>
        </header>
        {archiveError && (
          <p className={styles.inlineError} role="alert">
            {archiveError}
          </p>
        )}
        {Boolean(item.error) && (
          <p className={styles.inlineError} role="alert">
            {errorMessage(item.error, 'Could not refresh this item.')}
          </p>
        )}

        <details className={styles.brief}>
          <summary>Brief</summary>
          <dl className={styles.fieldList}>
            <BriefLine label="Topic" value={data.brief.topic} />
            <BriefLine label="Audience" value={data.brief.audience} />
            <BriefLine label="Objective" value={data.brief.objective} />
            <BriefLine label="Reference" value={data.brief.referenceUrl} />
            <BriefLine label="Notes" value={data.brief.notes} />
            <BriefLine label="Source facts" value={data.brief.sourceFacts?.join(' · ')} />
          </dl>
        </details>

        <GenerationProgress itemId={data.id} itemChannels={data.channels} jobs={data.jobs} onChanged={reloadAll} />

        <section className={styles.detailSection} aria-label="Variants">
          {groups.length === 0 && (
            <p className={styles.empty}>No variants yet. They appear here as soon as generation finishes.</p>
          )}
          {activeGroup && activeVariant && <>
            <div className={styles.workspaceChannels} role="group" aria-label="Content channel">
              {groups.map((group) => <button key={group.channel} type="button" aria-pressed={activeGroup.channel === group.channel} onClick={() => chooseVariant(group.channel, null)}>
                {CHANNEL_LABELS[group.channel]} <span>{group.variants.length}</span>
              </button>)}
            </div>
            <div className={styles.workspace}>
              <nav className={styles.variantNav} aria-label={`${CHANNEL_LABELS[activeGroup.channel]} variants`}>
                <h3>Variants</h3>
                {activeGroup.variants.map((variant) => <button key={variant.id} type="button" aria-current={activeVariant.id === variant.id ? 'true' : undefined} onClick={() => chooseVariant(activeGroup.channel, variant.id)}>
                  <strong>{variant.style}</strong>
                  <span>{variant.current ? `${variant.current.review === 'pending' ? 'Pending review' : variant.current.review} · Revision ${variant.current.revisionNumber}` : 'Generating'}</span>
                </button>)}
              </nav>
              <VariantCard key={activeVariant.id} itemId={data.id} variant={activeVariant} assets={assetList} onChanged={item.reload} onPublish={setPublishing} onCreateEmail={onCreateEmail} onDirtyChange={onDirtyChange} />
            </div>
          </>}
        </section>

        <section className={styles.detailSection} aria-label="Media and publication history">
          <div className={styles.workspaceChannels} role="group" aria-label="Item details">
            <button type="button" aria-pressed={detailPanel === 'media'} onClick={() => setDetailPanel('media')}>Media</button>
            <button type="button" aria-pressed={detailPanel === 'history'} onClick={() => setDetailPanel('history')}>Publication history</button>
          </div>
          {detailPanel === 'media' && <AssetLibrary itemId={data.id} assets={assetList} loading={assets.loading} error={assets.error} onReload={assets.reload} knownJobIds={data.jobs.map((job) => job.id)} />}
          {detailPanel === 'history' && <PublicationHistory key={publicationsVersion} itemId={data.id} embedded />}
        </section>
      </div>

      {publishing && (
        <PublishDialog
          variant={publishing}
          assets={assetList}
          onClose={() => setPublishing(null)}
          onOpenSettings={onOpenSettings}
          onPublished={() => {
            setPublicationsVersion((value) => value + 1)
            item.reload()
          }}
        />
      )}
    </div>
  )
}

function BriefLine({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

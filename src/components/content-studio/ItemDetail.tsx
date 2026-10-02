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
import variantStyles from './Variant.module.css'

type ItemDetailProps = {
  itemId: string
  onBack: () => void
  onOpenSettings?: () => void
  onCreateEmail?: (variantId: string, revisionId: string) => void
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
export default function ItemDetail({ itemId, onBack, onOpenSettings, onCreateEmail }: ItemDetailProps) {
  const loadItem = useCallback(() => getItem(itemId), [itemId])
  const loadAssets = useCallback(async (): Promise<ContentAsset[]> => (await listAssets({ itemId, pageSize: ASSET_PAGE_SIZE })).assets, [itemId])
  const item = useResource(loadItem)
  const assets = useResource(loadAssets)
  const [publishing, setPublishing] = useState<ContentVariant | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [publicationsVersion, setPublicationsVersion] = useState(0)

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
          {groupByChannel(data.variants).length === 0 && (
            <p className={styles.empty}>No variants yet. They appear here as soon as generation finishes.</p>
          )}
          {groupByChannel(data.variants).map((group) => (
            <div key={group.channel} className={variantStyles.channelGroup}>
              <h3 className={styles.sectionTitle}>{CHANNEL_LABELS[group.channel]}</h3>
              <div className={variantStyles.variantGrid}>
                {group.variants.map((variant) => (
                  <VariantCard
                    key={variant.id}
                    itemId={data.id}
                    variant={variant}
                    assets={assetList}
                    onChanged={item.reload}
                    onPublish={setPublishing}
                    onCreateEmail={onCreateEmail}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>

        <AssetLibrary
          itemId={data.id}
          assets={assetList}
          loading={assets.loading}
          error={assets.error}
          onReload={assets.reload}
          knownJobIds={data.jobs.map((job) => job.id)}
        />

        <PublicationHistory key={publicationsVersion} itemId={data.id} embedded />
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

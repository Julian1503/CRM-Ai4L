'use client'

import { useEffect, useState } from 'react'

import EmailPreview from '@/components/content-studio/EmailPreview'
import type { CampaignContentSummary } from '@/lib/marketing/campaignContent'

import styles from './marketing.module.css'

/**
 * A Content Studio email in Campaigns: read-only, because its content is an immutable
 * snapshot whose hash the approval binds to. Changing it means editing the post in the
 * Studio and creating a new email from it.
 */

const CTA_LABELS: Record<CampaignContentSummary['ctaMode'], string> = {
  booking: 'Booking button (a personal link per recipient)',
  external_url: 'Button linking to',
  none: 'No button',
}

export default function StudioCampaignContent({ campaignId }: { campaignId: string }) {
  const [content, setContent] = useState<CampaignContentSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/campaigns/${campaignId}/content`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `Request failed (HTTP ${response.status})`)
        if (!cancelled) setContent(body.content ?? null)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load the email content.')
      })
    return () => {
      cancelled = true
    }
  }, [campaignId])

  if (error) return <div className={styles.error} role="alert">{error}</div>
  if (!content) return <p className={styles.panelHint}>Loading the email content…</p>

  const revision = content.sourceRevisionNumber ? `revision ${content.sourceRevisionNumber}` : `revision ${content.sourceRevisionId.slice(0, 8)}`

  return (
    <section className={styles.panel} aria-label="Email content" data-testid={`studio-content-${campaignId}`}>
      <p className={styles.panelHint} data-testid="studio-content-source">
        Content comes from Content Studio ({revision}) and cannot be edited here.{' '}
        {content.sourceItemId && (
          <a href={`/?view=content&item=${encodeURIComponent(content.sourceItemId)}`}>Open it in the Content Studio</a>
        )}
      </p>
      <dl className={styles.itemMeta}>
        <div>
          <dt>Template contract</dt>
          <dd>{content.contract.id} v{content.contract.version} · {content.contract.label}</dd>
        </div>
        <div>
          <dt>Subject</dt>
          <dd>{content.subject ?? '—'}</dd>
        </div>
        <div>
          <dt>Call to action</dt>
          <dd>
            {CTA_LABELS[content.ctaMode]}
            {content.ctaMode === 'external_url' && content.ctaUrl ? ` ${content.ctaUrl}` : ''}
          </dd>
        </div>
        {Object.entries(content.fields).map(([tag, value]) => (
          <div key={tag}>
            <dt>{tag}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {content.assets.map((asset) => (
          <div key={asset.publishedAssetId}>
            <dt>Image</dt>
            <dd>{asset.alt}</dd>
          </div>
        ))}
        <div>
          <dt>Content hash</dt>
          <dd><code>{content.contentHash.slice(0, 16)}…</code></dd>
        </div>
      </dl>
      {content.renderedHtml && <EmailPreview html={content.renderedHtml} title="Reference HTML" />}
    </section>
  )
}

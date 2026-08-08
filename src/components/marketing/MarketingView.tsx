'use client'

import React, { useCallback, useEffect, useState } from 'react'

import { AU_STATES } from '@/lib/contacts/states'

import styles from './marketing.module.css'

type Segment = {
  id: string
  name: string
  description: string | null
  definition: Record<string, unknown>
}

type Campaign = {
  id: string
  name: string
  status: 'draft' | 'in_review' | 'approved' | 'sending' | 'sent' | 'failed'
  segment_id: string | null
  provider_automation_id: string | null
  segment?: { name: string } | null
}

type Preview = {
  total: number
  truncated: boolean
  estimatedSendMs: number
}

export type JobTypeOption = { id: string; name: string }

function formatDuration(ms: number): string {
  if (ms < 1000) return 'under a second'
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return `${Math.round(ms / 1000)} seconds`
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

export default function MarketingView({ jobTypes }: { jobTypes: JobTypeOption[] }) {
  const [segments, setSegments] = useState<Segment[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Segment draft
  const [segmentName, setSegmentName] = useState('')
  const [segmentState, setSegmentState] = useState('')
  const [segmentJobType, setSegmentJobType] = useState('')
  const [segmentStatus, setSegmentStatus] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)

  // Campaign draft
  const [campaignName, setCampaignName] = useState('')
  const [campaignSegment, setCampaignSegment] = useState('')
  const [automationId, setAutomationId] = useState('')

  const load = useCallback(async () => {
    try {
      const [segmentsResponse, campaignsResponse] = await Promise.all([
        fetch('/api/segments'),
        fetch('/api/campaigns'),
      ])

      if (segmentsResponse.ok) {
        setSegments((await segmentsResponse.json()).segments ?? [])
      }
      if (campaignsResponse.ok) {
        setCampaigns((await campaignsResponse.json()).campaigns ?? [])
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load marketing data.')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const definition = React.useMemo(
    () => ({
      ...(segmentState ? { state: segmentState } : {}),
      ...(segmentJobType ? { jobTypeId: segmentJobType } : {}),
      ...(segmentStatus ? { status: segmentStatus } : {}),
    }),
    [segmentState, segmentJobType, segmentStatus]
  )

  // Live audience size. Debounced so dragging through a dropdown does not fire a
  // request per keystroke.
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/segments/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition }),
        })

        setPreview(response.ok ? await response.json() : null)
      } catch {
        setPreview(null)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [definition])

  const createSegment = async () => {
    setError(null)
    setBusy('segment')

    try {
      const response = await fetch('/api/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: segmentName, definition }),
      })

      if (!response.ok) throw new Error(await readError(response))

      setSegmentName('')
      await load()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create segment.')
    } finally {
      setBusy(null)
    }
  }

  const createCampaign = async () => {
    setError(null)
    setBusy('campaign')

    try {
      const response = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: campaignName,
          segmentId: campaignSegment || null,
          providerAutomationId: automationId,
        }),
      })

      if (!response.ok) throw new Error(await readError(response))

      setCampaignName('')
      setAutomationId('')
      await load()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create campaign.')
    } finally {
      setBusy(null)
    }
  }

  const act = async (campaign: Campaign, action: 'review' | 'approve' | 'send') => {
    setError(null)
    setBusy(campaign.id)

    try {
      if (action === 'review') {
        // Moving to review is a plain status change; approval is the guarded step.
        const response = await fetch(`/api/campaigns/${campaign.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'in_review' }),
        })
        if (!response.ok) throw new Error(await readError(response))
      }

      if (action === 'approve') {
        const response = await fetch(`/api/campaigns/${campaign.id}/approve`, { method: 'POST' })
        if (!response.ok) throw new Error(await readError(response))
      }

      if (action === 'send') {
        // The endpoint handles one chunk per call, because sending is one API call
        // per recipient against a rate limit. Keep going until it says it is done.
        let guard = 0
        for (;;) {
          const response = await fetch(`/api/campaigns/${campaign.id}/send`, { method: 'POST' })
          if (!response.ok) throw new Error(await readError(response))

          const result = await response.json()
          if (!result.hasMore) break

          guard += 1
          if (guard > 200) {
            throw new Error('Send is taking longer than expected. Resume it from this screen.')
          }
        }
      }

      await load()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Action failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={styles.layout}>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      {/* The provider constraint is stated up front because it is genuinely
          surprising: you cannot author the email here. */}
      <div className={styles.constraint}>
        <strong>How sending works.</strong> EmailOctopus does not allow campaigns to be
        created through its API, so the email itself is authored in EmailOctopus as an
        automation using the <em>Started via API</em> trigger. This screen selects who
        receives it and when it goes. Sending is one request per recipient, so large
        segments take time — the estimate below is real.
      </div>

      <section className={styles.panel} aria-labelledby="segments-heading">
        <h2 id="segments-heading" className={styles.panelTitle}>
          Segments
        </h2>
        <p className={styles.panelHint}>
          Segments always exclude archived contacts and anyone not subscribed to the
          newsletter.
        </p>

        <div className={styles.formRow}>
          <label className={styles.field}>
            <span className={styles.label}>Name</span>
            <input
              className={styles.input}
              value={segmentName}
              onChange={(event) => setSegmentName(event.target.value)}
              placeholder="NSW electricians"
              data-testid="segment-name"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>State</span>
            <select
              className={styles.input}
              value={segmentState}
              onChange={(event) => setSegmentState(event.target.value)}
              data-testid="segment-state"
            >
              <option value="">Any state</option>
              {AU_STATES.map((state) => (
                <option key={state.code} value={state.code}>
                  {state.code}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Job type</span>
            <select
              className={styles.input}
              value={segmentJobType}
              onChange={(event) => setSegmentJobType(event.target.value)}
              data-testid="segment-job-type"
            >
              <option value="">Any job type</option>
              {jobTypes.map((jobType) => (
                <option key={jobType.id} value={jobType.id}>
                  {jobType.name}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Status</span>
            <select
              className={styles.input}
              value={segmentStatus}
              onChange={(event) => setSegmentStatus(event.target.value)}
              data-testid="segment-status"
            >
              <option value="">Any status</option>
              <option value="lead">Lead</option>
              <option value="prospect">Prospect</option>
              <option value="customer">Customer</option>
            </select>
          </label>
        </div>

        <div className={styles.previewRow}>
          <div className={styles.preview} data-testid="segment-preview">
            {preview ? (
              <>
                <span className={styles.previewCount}>{preview.total}</span>
                <span className={styles.previewLabel}>
                  subscribed contact{preview.total === 1 ? '' : 's'} match
                  {preview.total === 1 ? 'es' : ''}
                </span>
                {preview.total > 0 && (
                  <span className={styles.previewMeta}>
                    ≈ {formatDuration(preview.estimatedSendMs)} to send
                  </span>
                )}
                {preview.truncated && (
                  <span className={styles.previewWarning}>
                    Capped — only the first 10,000 will receive this.
                  </span>
                )}
              </>
            ) : (
              <span className={styles.previewLabel}>Counting…</span>
            )}
          </div>

          <button
            type="button"
            className={styles.primaryBtn}
            onClick={createSegment}
            disabled={!segmentName.trim() || busy !== null}
            data-testid="create-segment"
          >
            {busy === 'segment' ? 'Saving…' : 'Save segment'}
          </button>
        </div>

        <ul className={styles.list}>
          {segments.length === 0 && <li className={styles.empty}>No segments yet.</li>}
          {segments.map((segment) => (
            <li key={segment.id} className={styles.listItem}>
              <span className={styles.itemName}>{segment.name}</span>
              <span className={styles.itemMeta}>
                {Object.entries(segment.definition ?? {})
                  .map(([key, value]) => `${key}: ${String(value)}`)
                  .join(' · ') || 'All subscribed contacts'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.panel} aria-labelledby="campaigns-heading">
        <h2 id="campaigns-heading" className={styles.panelTitle}>
          Campaigns
        </h2>

        <div className={styles.formRow}>
          <label className={styles.field}>
            <span className={styles.label}>Name</span>
            <input
              className={styles.input}
              value={campaignName}
              onChange={(event) => setCampaignName(event.target.value)}
              placeholder="August consultation offer"
              data-testid="campaign-name"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Segment</span>
            <select
              className={styles.input}
              value={campaignSegment}
              onChange={(event) => setCampaignSegment(event.target.value)}
              data-testid="campaign-segment"
            >
              <option value="">Choose a segment</option>
              {segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>EmailOctopus automation ID</span>
            <input
              className={styles.input}
              value={automationId}
              onChange={(event) => setAutomationId(event.target.value)}
              placeholder="Required before approval"
              data-testid="campaign-automation"
            />
          </label>
        </div>

        <button
          type="button"
          className={styles.primaryBtn}
          onClick={createCampaign}
          disabled={!campaignName.trim() || busy !== null}
          data-testid="create-campaign"
        >
          {busy === 'campaign' ? 'Saving…' : 'Create draft'}
        </button>

        <ul className={styles.list}>
          {campaigns.length === 0 && <li className={styles.empty}>No campaigns yet.</li>}
          {campaigns.map((campaign) => (
            <li key={campaign.id} className={styles.campaignItem}>
              <div className={styles.campaignMain}>
                <span className={styles.itemName}>{campaign.name}</span>
                <span className={styles.itemMeta}>
                  {campaign.segment?.name ?? 'No segment'}
                  {!campaign.provider_automation_id && ' · no automation ID'}
                </span>
              </div>

              <span className={`${styles.status} ${styles[`status_${campaign.status}`]}`}>
                {campaign.status.replace('_', ' ')}
              </span>

              <div className={styles.actions}>
                {campaign.status === 'draft' && (
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => act(campaign, 'review')}
                    disabled={busy !== null}
                  >
                    Send for review
                  </button>
                )}
                {campaign.status === 'in_review' && (
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={() => act(campaign, 'approve')}
                    disabled={busy !== null}
                    data-testid={`approve-${campaign.id}`}
                  >
                    Approve
                  </button>
                )}
                {(campaign.status === 'approved' || campaign.status === 'sending') && (
                  <button
                    type="button"
                    className={styles.dangerBtn}
                    onClick={() => act(campaign, 'send')}
                    disabled={busy !== null}
                    data-testid={`send-${campaign.id}`}
                  >
                    {campaign.status === 'sending' ? 'Resume send' : 'Send now'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

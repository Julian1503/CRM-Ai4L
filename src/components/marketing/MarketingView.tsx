'use client'

import React, { useCallback, useEffect, useState } from 'react'

import { AU_STATES } from '@/lib/contacts/states'
import type { FacetCounts, SegmentFacets } from '@/lib/marketing/facets'

import Pagination from '@/components/ui/Pagination'

import CampaignCopyEditor from './CampaignCopyEditor'
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
  merge_fields: Record<string, string>
  segment?: { name: string } | null
}

type Preview = {
  total: number
  truncated: boolean
  estimatedSendMs: number
  /** Per-option counts for the three filter lists; absent on an older cached response. */
  facets?: SegmentFacets & { truncated: boolean }
}

export type JobTypeOption = { id: string; name: string }

/** Campaign statuses whose copy can still be rewritten, mirroring the generate route. */
const COPY_EDITABLE_STATUSES = new Set<Campaign['status']>(['draft', 'failed'])

/**
 * Names the copy panel after what it is for.
 *
 * The control used to read "Copy", which in a list of campaigns looks like a duplicate
 * button rather than the way in to the AI copywriter -- the only place in the app that
 * writes campaign text. Nothing else on screen mentions it, so an operator with a
 * segment and a draft had no visible route to the feature.
 */
function copyToggleLabel(campaign: Campaign, isOpen: boolean): string {
  if (isOpen) return 'Hide copy'

  const hasCopy = Object.values(campaign.merge_fields ?? {}).some(
    (value) => typeof value === 'string' && value.trim() !== ''
  )

  if (hasCopy) return COPY_EDITABLE_STATUSES.has(campaign.status) ? 'Edit copy' : 'View copy'

  return COPY_EDITABLE_STATUSES.has(campaign.status) ? 'Write copy with AI' : 'View copy'
}

/**
 * The ` (12)` a filter option carries.
 *
 * Counted against the other two selections, so the number says what picking this
 * option would actually leave you with rather than how many exist overall. Nothing is
 * shown until the first preview lands: a placeholder zero reads as "empty segment",
 * which is a different thing from "not counted yet".
 */
function optionCount(counts: FacetCounts | undefined, value: string): string {
  if (!counts) return ''

  return ` (${counts[value] ?? 0})`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return 'under a second'
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return `${Math.round(ms / 1000)} seconds`
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * Segments offered in the campaign form's dropdown.
 *
 * The API's own ceiling, so the picker holds every segment in all but pathological
 * cases — and `pickableTruncated` says so out loud when it does not.
 */
const SEGMENT_PICKER_LIMIT = 200

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

export default function MarketingView({ jobTypes }: { jobTypes: JobTypeOption[] }) {
  const [segments, setSegments] = useState<Segment[]>([])
  const [segmentsPage, setSegmentsPage] = useState(1)
  const [segmentsPageSize, setSegmentsPageSize] = useState(25)
  const [segmentsTotal, setSegmentsTotal] = useState(0)

  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignsPage, setCampaignsPage] = useState(1)
  const [campaignsPageSize, setCampaignsPageSize] = useState(25)
  const [campaignsTotal, setCampaignsTotal] = useState(0)

  // Every segment the campaign form can point at, fetched separately from the paged
  // list above: which segments you can *pick* must not depend on which page of the
  // segment list happens to be on screen.
  const [pickableSegments, setPickableSegments] = useState<Segment[]>([])
  const [pickableTruncated, setPickableTruncated] = useState(false)

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Segment draft
  const [segmentName, setSegmentName] = useState('')
  const [segmentState, setSegmentState] = useState('')
  const [segmentJobType, setSegmentJobType] = useState('')
  const [segmentStatus, setSegmentStatus] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)

  // Audience sizes, keyed by campaign *and* segment so a re-pointed campaign does not
  // read a stale count. The composer says who the email is going to, and refuses to
  // generate for nobody -- which the route rejects with a 409 the operator would
  // otherwise only meet after clicking.
  const [audienceByCampaign, setAudienceByCampaign] = useState<Record<string, number>>({})

  // Which campaign's copy is open for review. One at a time: reviewing is a focused
  // act, and two expanded editors invite editing the wrong one.
  const [reviewingId, setReviewingId] = useState<string | null>(null)

  // Campaign draft
  const [campaignName, setCampaignName] = useState('')
  const [campaignSegment, setCampaignSegment] = useState('')
  const [automationId, setAutomationId] = useState('')
  const [campaignEdits, setCampaignEdits] = useState<
    Record<string, { segmentId: string; automationId: string }>
  >({})

  const load = useCallback(async () => {
    try {
      const [segmentsResponse, campaignsResponse, pickerResponse] = await Promise.all([
        fetch(`/api/segments?page=${segmentsPage}&pageSize=${segmentsPageSize}`),
        fetch(`/api/campaigns?page=${campaignsPage}&pageSize=${campaignsPageSize}`),
        fetch(`/api/segments?pageSize=${SEGMENT_PICKER_LIMIT}`),
      ])

      if (segmentsResponse.ok) {
        const body = await segmentsResponse.json()
        setSegments(body.segments ?? [])
        setSegmentsTotal(body.total ?? 0)
      }
      if (campaignsResponse.ok) {
        const body = await campaignsResponse.json()
        setCampaigns(body.campaigns ?? [])
        setCampaignsTotal(body.total ?? 0)
      }
      if (pickerResponse.ok) {
        const body = await pickerResponse.json()
        setPickableSegments(body.segments ?? [])
        setPickableTruncated((body.total ?? 0) > SEGMENT_PICKER_LIMIT)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load marketing data.')
    }
  }, [segmentsPage, segmentsPageSize, campaignsPage, campaignsPageSize])

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

  const reviewingCampaign = campaigns.find((item) => item.id === reviewingId)
  const reviewingSegment = pickableSegments.find(
    (item) => item.id === reviewingCampaign?.segment_id
  )
  // Derived, not stored: "not counted yet" is the absence of a key, so closing and
  // reopening a panel never flashes a stale number.
  const audienceKey =
    reviewingCampaign && reviewingSegment
      ? `${reviewingCampaign.id}:${reviewingSegment.id}`
      : null
  const reviewingAudience = audienceKey ? audienceByCampaign[audienceKey] : undefined

  useEffect(() => {
    if (!audienceKey || !reviewingSegment || reviewingAudience !== undefined) return

    let cancelled = false

    void (async () => {
      try {
        const response = await fetch('/api/segments/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition: reviewingSegment.definition }),
        })

        if (!response.ok) return

        const body = await response.json()

        // Recorded only when the server actually returned a number: "not counted"
        // must not masquerade as "matches nobody" and block generation wrongly.
        if (!cancelled && typeof body.total === 'number') {
          setAudienceByCampaign((current) => ({ ...current, [audienceKey]: body.total }))
        }
      } catch {
        // The composer falls back to naming the segment without a count.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [audienceKey, reviewingSegment, reviewingAudience])

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
      // Listings are newest-first, so the new record is on page 1 — not wherever the
      // user happened to be paged to.
      setSegmentsPage(1)
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
      setCampaignsPage(1)
      await load()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create campaign.')
    } finally {
      setBusy(null)
    }
  }

  const saveCampaignSettings = async (campaign: Campaign) => {
    const edit = campaignEdits[campaign.id] ?? {
      segmentId: campaign.segment_id ?? '',
      automationId: campaign.provider_automation_id ?? '',
    }

    setError(null)
    setBusy(campaign.id)

    try {
      const response = await fetch(`/api/campaigns/${campaign.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segmentId: edit.segmentId,
          providerAutomationId: edit.automationId,
        }),
      })
      if (!response.ok) throw new Error(await readError(response))

      setCampaignEdits((current) => {
        const next = { ...current }
        delete next[campaign.id]
        return next
      })
      await load()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save campaign settings.')
    } finally {
      setBusy(null)
    }
  }

  const act = async (
    campaign: Campaign,
    action: 'draft' | 'review' | 'approve' | 'send'
  ) => {
    setError(null)
    setBusy(campaign.id)

    try {
      if (action === 'draft' || action === 'review') {
        // Moving to review is a plain status change; approval is the guarded step.
        const response = await fetch(`/api/campaigns/${campaign.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: action === 'draft' ? 'draft' : 'in_review' }),
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
              <option value="">Any state{optionCount(preview?.facets?.state, '')}</option>
              {AU_STATES.map((state) => (
                <option key={state.code} value={state.code}>
                  {state.code}
                  {optionCount(preview?.facets?.state, state.code)}
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
              <option value="">Any job type{optionCount(preview?.facets?.jobType, '')}</option>
              {jobTypes.map((jobType) => (
                <option key={jobType.id} value={jobType.id}>
                  {jobType.name}
                  {optionCount(preview?.facets?.jobType, jobType.id)}
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
              <option value="">Any status{optionCount(preview?.facets?.status, '')}</option>
              <option value="lead">Lead{optionCount(preview?.facets?.status, 'lead')}</option>
              <option value="prospect">
                Prospect{optionCount(preview?.facets?.status, 'prospect')}
              </option>
              <option value="customer">
                Customer{optionCount(preview?.facets?.status, 'customer')}
              </option>
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
                {preview.total === 0 && (
                  <span className={styles.previewWarning} data-testid="segment-preview-empty">
                    Nothing matches these filters. A campaign on this segment cannot
                    generate copy or send.
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

        <Pagination
          page={segmentsPage}
          pageSize={segmentsPageSize}
          total={segmentsTotal}
          shown={segments.length}
          onPageChange={setSegmentsPage}
          onPageSizeChange={(size) => {
            setSegmentsPageSize(size)
            setSegmentsPage(1)
          }}
          label="segments"
          testId="segments-pagination"
        />
      </section>

      <section className={styles.panel} aria-labelledby="campaigns-heading">
        <h2 id="campaigns-heading" className={styles.panelTitle}>
          Campaigns
        </h2>
        <p className={styles.panelHint}>
          Create a draft against a segment, then open <strong>Write copy with AI</strong>{' '}
          to have Claude draft the campaign fields for that audience. Copy and settings
          can be changed while a campaign is a draft or after a failed send.
        </p>

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
              {pickableSegments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name}
                </option>
              ))}
            </select>
            {pickableTruncated && (
              <span className={styles.label} data-testid="segment-picker-truncated">
                Showing the first {SEGMENT_PICKER_LIMIT} segments only.
              </span>
            )}
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
          {campaigns.map((campaign) => {
            const edit = campaignEdits[campaign.id] ?? {
              segmentId: campaign.segment_id ?? '',
              automationId: campaign.provider_automation_id ?? '',
            }

            return (
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
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() =>
                    setReviewingId((current) => (current === campaign.id ? null : campaign.id))
                  }
                  aria-expanded={reviewingId === campaign.id}
                  data-testid={`review-copy-${campaign.id}`}
                >
                  {copyToggleLabel(campaign, reviewingId === campaign.id)}
                </button>
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
                  <>
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => act(campaign, 'draft')}
                      disabled={busy !== null}
                      data-testid={`draft-${campaign.id}`}
                    >
                      Return to draft
                    </button>
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      onClick={() => act(campaign, 'approve')}
                      disabled={busy !== null}
                      data-testid={`approve-${campaign.id}`}
                    >
                      Approve
                    </button>
                  </>
                )}
                {campaign.status === 'approved' && (
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => act(campaign, 'draft')}
                    disabled={busy !== null}
                    data-testid={`draft-${campaign.id}`}
                  >
                    Return to draft
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
                {campaign.status === 'failed' && (
                  <>
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => act(campaign, 'draft')}
                      disabled={busy !== null}
                      data-testid={`draft-${campaign.id}`}
                    >
                      Return to draft
                    </button>
                    <button
                      type="button"
                      className={styles.dangerBtn}
                      onClick={() => act(campaign, 'send')}
                      disabled={busy !== null}
                      data-testid={`retry-${campaign.id}`}
                    >
                      Retry failed
                    </button>
                  </>
                )}
              </div>

              {COPY_EDITABLE_STATUSES.has(campaign.status) && (
                <div className={styles.campaignSettings}>
                  <label className={styles.field}>
                    <span className={styles.label}>Segment</span>
                    <select
                      className={styles.input}
                      value={edit.segmentId}
                      onChange={(event) =>
                        setCampaignEdits((current) => ({
                          ...current,
                          [campaign.id]: { ...edit, segmentId: event.target.value },
                        }))
                      }
                      data-testid={`edit-segment-${campaign.id}`}
                    >
                      <option value="">Choose a segment</option>
                      {pickableSegments.map((segment) => (
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
                      value={edit.automationId}
                      onChange={(event) =>
                        setCampaignEdits((current) => ({
                          ...current,
                          [campaign.id]: { ...edit, automationId: event.target.value },
                        }))
                      }
                      placeholder="Required before approval"
                      data-testid={`edit-automation-${campaign.id}`}
                    />
                  </label>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => saveCampaignSettings(campaign)}
                    disabled={busy !== null}
                    data-testid={`save-settings-${campaign.id}`}
                  >
                    Save settings
                  </button>
                </div>
              )}

              {reviewingId === campaign.id && (
                <CampaignCopyEditor
                  campaignId={campaign.id}
                  campaignName={campaign.name}
                  audienceLabel={campaign.segment?.name ?? undefined}
                  audienceSize={reviewingAudience}
                  editable={COPY_EDITABLE_STATUSES.has(campaign.status)}
                  mergeFields={campaign.merge_fields ?? {}}
                  onSaved={(mergeFields, status) => {
                    // Take the status from the server rather than assuming. Generating
                    // copy moves a campaign back to draft; plainly saving an edit does
                    // not, and a failed campaign stays failed either way.
                    setCampaigns((current) =>
                      current.map((item) =>
                        item.id === campaign.id
                          ? {
                              ...item,
                              merge_fields: mergeFields,
                              status: (status as Campaign['status']) ?? item.status,
                            }
                          : item
                      )
                    )
                  }}
                  onError={(message) => setError(message || null)}
                />
              )}
            </li>
            )
          })}
        </ul>

        <Pagination
          page={campaignsPage}
          pageSize={campaignsPageSize}
          total={campaignsTotal}
          shown={campaigns.length}
          onPageChange={setCampaignsPage}
          onPageSizeChange={(size) => {
            setCampaignsPageSize(size)
            setCampaignsPage(1)
          }}
          label="campaigns"
          testId="campaigns-pagination"
        />
      </section>
    </div>
  )
}

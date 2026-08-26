'use client'

import React, { useCallback, useEffect, useState } from 'react'

import { AU_STATES } from '@/lib/contacts/states'
import type { FacetCounts, SegmentFacets } from '@/lib/marketing/facets'

import Pagination from '@/components/ui/Pagination'

import AudienceModal, { type Audience } from './AudienceModal'
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

/**
 * What the send ledger says about one campaign, as `/api/campaigns/[id]/send` reports
 * it. Read for campaigns that are sending or have failed, so "failed" is never a bare
 * word on screen.
 */
type SendReport = {
  total: number
  sent: number
  failed: number
  pending: number
  failureReason: string | null
  stallReason: string | null
}

/** One chunk's own result, as opposed to the campaign's cumulative totals. */
type SendChunk = {
  processed: number
  sent: number
  failed: number
  deferred: number
  reason: string | null
}

type SendResult = {
  hasMore?: boolean
  sent?: number
  failed?: number
  pending?: number
  failureReason?: string | null
  chunk?: SendChunk
}

/** Campaign statuses whose send ledger is worth reading back. */
const REPORTED_STATUSES = new Set<Campaign['status']>(['sending', 'failed'])

/**
 * How many chunks one click will drive before handing back control.
 *
 * 200 chunks of 200 recipients covers any segment the preview will let through. Hitting
 * it means something is wrong rather than large.
 */
const MAX_SEND_CHUNKS = 200

/**
 * What to tell the operator when a send finishes with failures.
 *
 * The whole reason this exists: the endpoint answers 200 for a send in which every
 * single recipient failed, so success at the HTTP level said nothing about success at
 * the campaign level, and the click appeared to work while the campaign quietly went
 * to "failed".
 */
function describeSendOutcome(result: SendResult): string | null {
  const failed = result.failed ?? 0

  if (failed === 0) return null

  const sent = result.sent ?? 0
  const reason = result.failureReason
    ? ` EmailOctopus said: ${result.failureReason}`
    : ''

  if (sent === 0) {
    return `The send failed. None of the ${failed} recipients were emailed.${reason}`
  }

  return `Sent to ${sent} of ${sent + failed} recipients. ${failed} failed.${reason}`
}

/**
 * What to tell the operator when a chunk moves nothing.
 *
 * Every attempt came back retryable — a rate limit, or the provider being down — so the
 * rows stay pending and repeating the call would spin. Naming the provider's reason is
 * the difference between "try again later" and an hour of guessing.
 */
function describeStall(chunk: SendChunk): string {
  const scope = `${chunk.deferred} recipient${chunk.deferred === 1 ? '' : 's'}`

  return chunk.reason
    ? `Sending paused with ${scope} still to go — EmailOctopus is not accepting sends ` +
        `right now: ${chunk.reason} The campaign stays resumable; use "Resume send" ` +
        `once it recovers.`
    : `Sending paused with ${scope} still to go, because EmailOctopus kept deferring ` +
        `the requests. The campaign stays resumable; use "Resume send" to continue.`
}

/** A one-line summary of a campaign's ledger, for the row itself. */
function describeReport(report: SendReport): string {
  if (report.failed > 0) {
    const reason = report.failureReason ? ` — ${report.failureReason}` : ''

    return `${report.failed} of ${report.total} recipients failed${reason}`
  }

  if (report.pending > 0) {
    const reason = report.stallReason ? ` — ${report.stallReason}` : ''

    return `${report.sent} of ${report.total} sent, ${report.pending} still to go${reason}`
  }

  return `${report.sent} of ${report.total} sent`
}

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

  // Per-campaign send reports, so a failure outlives the click that caused it.
  const [sendReports, setSendReports] = useState<Record<string, SendReport>>({})

  // The campaign whose recipient list is open, and that list.
  const [audienceFor, setAudienceFor] = useState<Campaign | null>(null)
  const [audience, setAudience] = useState<Audience | null>(null)
  const [audienceLoading, setAudienceLoading] = useState(false)
  const [audienceError, setAudienceError] = useState<string | null>(null)
  const [audiencePage, setAudiencePage] = useState(1)
  const [audiencePageSize, setAudiencePageSize] = useState(25)

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

  /**
   * Reads the ledger for campaigns that are sending or have failed.
   *
   * Fetched in parallel and merged rather than replaced, so a report already on screen
   * survives a refresh whose request fails.
   */
  const loadSendReports = useCallback(async (targets: Campaign[]) => {
    if (targets.length === 0) return

    const entries = await Promise.all(
      targets.map(async (campaign) => {
        try {
          const response = await fetch(`/api/campaigns/${campaign.id}/send`)

          if (!response.ok) return null

          const body = await response.json()

          // The endpoint answers with counts; anything else is a routing accident and
          // must not render as "0 of 0 sent".
          if (typeof body?.total !== 'number') return null

          return [campaign.id, body as SendReport] as const
        } catch {
          return null
        }
      })
    )

    const found = entries.filter((entry): entry is [string, SendReport] => entry !== null)

    if (found.length === 0) return

    setSendReports((current) => ({ ...current, ...Object.fromEntries(found) }))
  }, [])

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
        const loaded: Campaign[] = body.campaigns ?? []

        setCampaigns(loaded)
        setCampaignsTotal(body.total ?? 0)
        // Only for the campaigns that have something to report — a draft has no ledger,
        // and a request per row would be a page of requests for nothing.
        void loadSendReports(loaded.filter((item) => REPORTED_STATUSES.has(item.status)))
      }
      if (pickerResponse.ok) {
        const body = await pickerResponse.json()
        setPickableSegments(body.segments ?? [])
        setPickableTruncated((body.total ?? 0) > SEGMENT_PICKER_LIMIT)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load marketing data.')
    }
  }, [segmentsPage, segmentsPageSize, campaignsPage, campaignsPageSize, loadSendReports])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // Reads the recipient list for whichever campaign is open, re-running when the pager
  // moves. Kept out of `load()` on purpose: the workspace refreshes for reasons that
  // have nothing to do with the dialog, and re-fetching ten thousand names each time
  // would be a lot of work to show nobody.
  useEffect(() => {
    if (!audienceFor) return

    let cancelled = false

    void (async () => {
      // Inside the async body rather than the effect's: a synchronous setState here
      // would make every open of the dialog cost an extra render pass.
      setAudienceLoading(true)
      setAudienceError(null)

      try {
        const response = await fetch(
          `/api/campaigns/${audienceFor.id}/audience?page=${audiencePage}&pageSize=${audiencePageSize}`
        )

        if (!response.ok) throw new Error(await readError(response))

        const body = await response.json()

        if (!cancelled) setAudience(body as Audience)
      } catch (audienceLoadError) {
        if (cancelled) return

        setAudienceError(
          audienceLoadError instanceof Error
            ? audienceLoadError.message
            : 'Could not load the recipients.'
        )
      } finally {
        if (!cancelled) setAudienceLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [audienceFor, audiencePage, audiencePageSize])

  const openAudience = (campaign: Campaign) => {
    // Cleared rather than kept: showing the previous campaign's recipients under this
    // campaign's name, even for a moment, is worse than showing nothing.
    setAudience(null)
    setAudienceError(null)
    setAudiencePage(1)
    setAudienceFor(campaign)
  }

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
    action: 'draft' | 'review' | 'approve' | 'send' | 'reopen'
  ) => {
    setError(null)
    setBusy(campaign.id)

    // Set when a send finishes with failures: a 200 that still needs saying out loud.
    let outcome: string | null = null

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

      if (action === 'reopen') {
        // Confirmed rather than done on the click: this ends with real mail going to
        // people who already received this campaign once, and the provider-side setting
        // it depends on is not visible from here.
        const confirmed = window.confirm(
          `Send "${campaign.name}" again?

It goes back to draft and starts a second send. Everyone the segment matches now will receive it, including the contacts who got it the first time. The previous send is kept as history.

You will approve it again before anything leaves, and EmailOctopus only delivers a repeat if the automation has "Allow contacts to repeat" enabled.`
        )

        if (!confirmed) return

        const response = await fetch(`/api/campaigns/${campaign.id}/reopen`, { method: 'POST' })
        if (!response.ok) throw new Error(await readError(response))

        // The previous run's figures describe a send that is over; keeping them would
        // let run 1's numbers appear under run 2 until the next fetch lands.
        setSendReports((current) => {
          const next = { ...current }
          delete next[campaign.id]
          return next
        })
      }

      if (action === 'send') {
        // The endpoint handles one chunk per call, because sending is one API call
        // per recipient against a rate limit. Keep going until it says it is done.
        let guard = 0
        for (;;) {
          const response = await fetch(`/api/campaigns/${campaign.id}/send`, { method: 'POST' })
          if (!response.ok) throw new Error(await readError(response))

          const result = (await response.json()) as SendResult
          const chunk = result.chunk

          // A chunk that attempted recipients and neither sent nor failed any of them
          // has made no progress; calling again would only repeat it.
          if (chunk && chunk.processed > 0 && chunk.sent === 0 && chunk.failed === 0) {
            throw new Error(describeStall(chunk))
          }

          if (!result.hasMore) {
            // A completed send is still a failed send when the ledger says so, and the
            // endpoint reports that with a 200.
            outcome = describeSendOutcome(result)
            break
          }

          guard += 1
          if (guard > MAX_SEND_CHUNKS) {
            throw new Error('Send is taking longer than expected. Resume it from this screen.')
          }
        }
      }

      await load()

      // After the reload, so the banner is not wiped by the refresh it describes.
      if (outcome) setError(outcome)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Action failed.')
      // The ledger holds the detail behind a mid-send failure; the row should show it
      // even though the loop stopped early.
      await load()
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

              {sendReports[campaign.id] && REPORTED_STATUSES.has(campaign.status) && (
                <p
                  className={
                    campaign.status === 'failed' ? styles.sendReportFailed : styles.sendReport
                  }
                  data-testid={`send-report-${campaign.id}`}
                >
                  {describeReport(sendReports[campaign.id])}
                </p>
              )}

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => openAudience(campaign)}
                  disabled={busy !== null}
                  data-testid={`audience-${campaign.id}`}
                >
                  Recipients
                </button>
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
                {campaign.status === 'sent' && (
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => act(campaign, 'reopen')}
                    disabled={busy !== null}
                    data-testid={`reopen-${campaign.id}`}
                  >
                    Send again
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

      {audienceFor && (
        <AudienceModal
          campaignName={audienceFor.name}
          audience={audience}
          loading={audienceLoading}
          error={audienceError}
          page={audiencePage}
          pageSize={audiencePageSize}
          onPageChange={setAudiencePage}
          onPageSizeChange={(size) => {
            setAudiencePageSize(size)
            setAudiencePage(1)
          }}
          onClose={() => setAudienceFor(null)}
        />
      )}
    </div>
  )
}

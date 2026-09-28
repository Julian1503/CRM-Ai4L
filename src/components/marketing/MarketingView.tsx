'use client'

import React, { useCallback, useEffect, useState } from 'react'

import type { ConsentStream } from '@/lib/db/types'
import { CONSENT_STREAM_LABELS, parseConsentStream } from '@/lib/marketing/consentStream'

import LifecycleActions from '@/components/ui/LifecycleActions'
import Pagination from '@/components/ui/Pagination'
import { campaignLifecycle } from '@/lib/lifecycle/entityLifecycle'

import AudienceModal, { type Audience } from './AudienceModal'
import AutomationConnectionField, {
  type AutomationStatus,
  type TemplateOption,
} from './AutomationConnectionField'
import CampaignCopyEditor from './CampaignCopyEditor'
import CampaignStreamField from './CampaignStreamField'
import SegmentsPanel from './SegmentsPanel'
import SendConfirmDialog from './SendConfirmDialog'
import styles from './marketing.module.css'
import StreamPill from './StreamPill'

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
  consent_stream: ConsentStream
  merge_fields: Record<string, string>
  segment?: { name: string } | null
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
 * Segments offered in the campaign form's dropdown.
 *
 * The API's own ceiling, so the picker holds every segment in all but pathological
 * cases — and `pickableTruncated` says so out loud when it does not.
 */
const SEGMENT_PICKER_LIMIT = 200

/**
 * How many automation ids one health check may ask about.
 *
 * Matches the API route's own cap. Each id costs a provider round trip, and campaigns
 * commonly share an automation, so a page of rows is far fewer than 25 in practice.
 */
const AUTOMATION_CHECK_LIMIT = 25

/**
 * The registered name for an automation id, or a shortened id when there is none.
 *
 * A bare `b690d44a-a0dd-11f1-9fa9-7381a1ee33bd` on a campaign row tells an operator
 * nothing about which email it sends, which is the whole reason the registry exists.
 */
function templateName(templates: TemplateOption[], automationId: string): string {
  const match = templates.find(
    (template) => template.provider_automation_id === automationId
  )

  return match ? match.name : `Unnamed automation ${automationId.slice(0, 8)}`
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

export default function MarketingView({ jobTypes }: { jobTypes: JobTypeOption[] }) {

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

  // Sending is irreversible. Verify the live audience before allowing the final click.
  const [sendConfirmation, setSendConfirmation] = useState<Campaign | null>(null)
  const [sendAudienceSize, setSendAudienceSize] = useState<number | null>(null)
  const [sendAudienceLoading, setSendAudienceLoading] = useState(false)
  const [sendAudienceError, setSendAudienceError] = useState<string | null>(null)


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
  const [campaignStream, setCampaignStream] = useState<ConsentStream | ''>('')
  const [campaignStreamFilter, setCampaignStreamFilter] = useState<ConsentStream | ''>('')
  const [awaitingOnly, setAwaitingOnly] = useState(false)

  // The named registry over automation ids, and what EmailOctopus says about each one.
  // Both exist because the provider has no endpoint that lists automations: a name can
  // only come from `campaign_templates`, and an id can only be checked by probing.
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [automationChecks, setAutomationChecks] = useState<Record<string, AutomationStatus>>({})
  const [campaignEdits, setCampaignEdits] = useState<
    Record<string, { segmentId: string; automationId: string }>
  >({})

  /**
   * Asks EmailOctopus whether each automation id still exists.
   *
   * Without this a wrong id is invisible until the send: every recipient fails, one
   * request at a time, and the reason lands in the ledger rather than on screen. The
   * check is safe to run on a whole page of campaigns — it queues a contact that cannot
   * exist, so it identifies the automation without sending anything.
   */
  const checkAutomations = useCallback(async (ids: string[]) => {
    const wanted = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))]

    if (wanted.length === 0) return

    setAutomationChecks((current) => ({
      ...current,
      ...Object.fromEntries(wanted.map((id) => [id, { status: 'checking' } as AutomationStatus])),
    }))

    try {
      const response = await fetch('/api/integrations/emailoctopus/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ automationIds: wanted.slice(0, AUTOMATION_CHECK_LIMIT) }),
      })

      const body = await response.json().catch(() => ({}))

      if (!response.ok) {
        // Credentials missing, or the endpoint itself failed. Reported against each id
        // as `unknown`, never as `invalid` — an operator must not be sent to fix an id
        // that was correct.
        const error = typeof body?.error === 'string' ? body.error : 'The check failed.'

        setAutomationChecks((current) => ({
          ...current,
          ...Object.fromEntries(wanted.map((id) => [id, { status: 'unknown', error }])),
        }))
        return
      }

      const results = (body?.results ?? {}) as Record<string, AutomationStatus>

      setAutomationChecks((current) => ({
        ...current,
        // Anything the server did not answer for stays as it was rather than becoming
        // a stuck 'checking'.
        ...Object.fromEntries(
          wanted.map((id) => [
            id,
            results[id] ?? { status: 'unknown', error: 'No answer for this ID.' },
          ])
        ),
      }))
    } catch {
      setAutomationChecks((current) => ({
        ...current,
        ...Object.fromEntries(
          wanted.map((id) => [
            id,
            { status: 'unknown', error: 'EmailOctopus could not be reached.' } as AutomationStatus,
          ])
        ),
      }))
    }
  }, [])

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
      const [campaignsResponse, pickerResponse, templatesResponse] =
        await Promise.all([
          fetch(
            `/api/campaigns?page=${campaignsPage}&pageSize=${campaignsPageSize}` +
              (campaignStreamFilter ? `&stream=${campaignStreamFilter}` : '') +
              (awaitingOnly ? '&status=in_review' : '')
          ),
          fetch(`/api/segments?pageSize=${SEGMENT_PICKER_LIMIT}`),
          fetch('/api/templates'),
        ])

      if (campaignsResponse.ok) {
        const body = await campaignsResponse.json()
        const loaded: Campaign[] = body.campaigns ?? []

        setCampaigns(loaded)
        setCampaignsTotal(body.total ?? 0)
        // Health check for the whole page at once, so a dead automation shows up
        // before someone approves the campaign rather than during its send.
        void checkAutomations(
          loaded.map((item) => item.provider_automation_id ?? '')
        )
        // Only for the campaigns that have something to report — a draft has no ledger,
        // and a request per row would be a page of requests for nothing.
        void loadSendReports(loaded.filter((item) => REPORTED_STATUSES.has(item.status)))
      }
      if (pickerResponse.ok) {
        const body = await pickerResponse.json()
        setPickableSegments(body.segments ?? [])
        setPickableTruncated((body.total ?? 0) > SEGMENT_PICKER_LIMIT)
      }
      if (templatesResponse.ok) {
        const body = await templatesResponse.json()
        setTemplates(body.templates ?? [])
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load marketing data.')
    }
  }, [
    campaignsPage,
    campaignsPageSize,
    campaignStreamFilter,
    awaitingOnly,
    loadSendReports,
    checkAutomations,
  ])

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


  // Checks the automation id on the draft campaign as it is chosen or typed. Debounced
  // for the same reason as the preview above: the manual field is a text box, and a
  // provider round trip per keystroke would be both slow and rate-limited.
  useEffect(() => {
    const id = automationId.trim()

    if (id === '') return

    const timer = setTimeout(() => void checkAutomations([id]), 500)

    return () => clearTimeout(timer)
  }, [automationId, checkAutomations])

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
          // With the id, so the count honours the segment's manual decisions.
          body: JSON.stringify({ segmentId: reviewingSegment.id, definition: reviewingSegment.definition }),
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


  // The registered template behind the automation picked, if there is one. Matched by
  // automation id because that is what the picker holds.
  const pickedTemplate =
    templates.find(
      (template) =>
        Boolean(template.provider_automation_id) &&
        template.provider_automation_id === automationId.trim()
    ) ?? null

  const createCampaign = async () => {
    setError(null)
    setBusy('campaign')

    try {
      const response = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A registered template carries its own automation and stream, and the server
        // reads both from it; only a hand-typed automation has to name its stream.
        body: JSON.stringify(
          pickedTemplate
            ? {
                name: campaignName,
                segmentId: campaignSegment || null,
                templateId: pickedTemplate.id,
              }
            : {
                name: campaignName,
                segmentId: campaignSegment || null,
                providerAutomationId: automationId,
                consentStream: campaignStream,
              }
        ),
      })

      if (!response.ok) throw new Error(await readError(response))

      setCampaignName('')
      setAutomationId('')
      setCampaignStream('')
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

  const requestSendConfirmation = async (campaign: Campaign) => {
    setSendConfirmation(campaign)
    setSendAudienceSize(null)
    setSendAudienceError(null)
    setSendAudienceLoading(true)

    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/preflight`)
      if (!response.ok) throw new Error(await readError(response))

      const body = await response.json()
      if (typeof body?.total !== 'number') throw new Error('Could not verify campaign audience.')

      setSendAudienceSize(body.total)
    } catch (requestError) {
      setSendAudienceError(
        requestError instanceof Error ? requestError.message : 'Could not verify campaign audience.'
      )
    } finally {
      setSendAudienceLoading(false)
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

  const confirmSend = () => {
    const campaign = sendConfirmation
    if (!campaign) return

    setSendConfirmation(null)
    void act(campaign, 'send')
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

      <SegmentsPanel jobTypes={jobTypes} onChanged={() => void load()} />

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

          <AutomationConnectionField
            value={automationId}
            onChange={setAutomationId}
            templates={templates}
            check={automationChecks[automationId.trim()]}
            testId="campaign-automation"
          />

          <CampaignStreamField
            inherited={pickedTemplate?.consent_stream ?? null}
            value={campaignStream}
            onChange={setCampaignStream}
          />
        </div>

        <button
          type="button"
          className={styles.primaryBtn}
          onClick={createCampaign}
          disabled={
            !campaignName.trim() || (!pickedTemplate && !campaignStream) || busy !== null
          }
          data-testid="create-campaign"
        >
          {busy === 'campaign' ? 'Saving…' : 'Create draft'}
        </button>

        <div className={styles.listFilter} role="group" aria-label="Filter campaigns">
          <span className={styles.label}>Show</span>
          <select
            className={styles.input}
            aria-label="Campaign stream"
            value={campaignStreamFilter}
            onChange={(event) => {
              setCampaignStreamFilter(parseConsentStream(event.target.value) ?? '')
              setCampaignsPage(1)
            }}
            data-testid="campaign-stream-filter"
          >
            <option value="">All campaigns</option>
            {(Object.keys(CONSENT_STREAM_LABELS) as ConsentStream[]).map((option) => (
              <option key={option} value={option}>
                {CONSENT_STREAM_LABELS[option]} only
              </option>
            ))}
          </select>
          <select
            className={styles.input}
            value={awaitingOnly ? 'in_review' : ''}
            onChange={(event) => {
              setAwaitingOnly(event.target.value === 'in_review')
              setCampaignsPage(1)
            }}
            aria-label="Campaign status"
            data-testid="campaign-status-filter"
          >
            <option value="">Any status</option>
            <option value="in_review">Waiting for approval</option>
          </select>
        </div>

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
                <span className={styles.itemName}>
                  {campaign.name}{' '}
                  <StreamPill
                    stream={campaign.consent_stream ?? 'newsletter'}
                    testId={`campaign-stream-${campaign.id}`}
                  />
                </span>
                <span className={styles.itemMeta}>
                  {campaign.segment?.name ?? 'No segment'}
                  {campaign.provider_automation_id
                    ? ` · ${templateName(templates, campaign.provider_automation_id)}`
                    : ' · template not connected'}
                </span>
                {/* Only a definite "EmailOctopus does not have this" is worth a
                    warning. A check that could not complete says nothing useful, and
                    a row that cried wolf would train an operator to ignore it. */}
                {automationChecks[campaign.provider_automation_id ?? '']?.status ===
                  'invalid' && (
                  <span
                    className={styles.checkFailed}
                    data-testid={`automation-warning-${campaign.id}`}
                  >
                    EmailOctopus does not have this automation. Every recipient would
                    fail — reconnect the template before sending.
                  </span>
                )}
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
                    onClick={() => void requestSendConfirmation(campaign)}
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
                      onClick={() => void requestSendConfirmation(campaign)}
                      disabled={busy !== null}
                      data-testid={`retry-${campaign.id}`}
                    >
                      Retry failed
                    </button>
                  </>
                )}
                <div className={styles.campaignLifecycle}>
                  <LifecycleActions
                    endpoint={`/api/campaigns/${campaign.id}`}
                    noun="campaign"
                    name={campaign.name}
                    archived={false}
                    // The list only holds live campaigns, so only the status can block.
                    lifecycle={campaignLifecycle({ status: campaign.status, archived_at: null, removed_at: null })}
                    onChanged={load}
                    testId={`campaign-${campaign.id}`}
                  />
                </div>
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
                  <AutomationConnectionField
                    value={edit.automationId}
                    onChange={(value) =>
                      setCampaignEdits((current) => ({
                        ...current,
                        [campaign.id]: { ...edit, automationId: value },
                      }))
                    }
                    templates={templates}
                    check={automationChecks[edit.automationId.trim()]}
                    testId={`edit-automation-${campaign.id}`}
                  />
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

      {sendConfirmation && (
        <SendConfirmDialog
          campaignName={sendConfirmation.name}
          audienceLabel={sendConfirmation.segment?.name ?? 'Selected segment'}
          audienceSize={sendAudienceSize}
          loading={sendAudienceLoading}
          error={sendAudienceError}
          onConfirm={confirmSend}
          onClose={() => {
            if (!sendAudienceLoading) setSendConfirmation(null)
          }}
        />
      )}
    </div>
  )
}

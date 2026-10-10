import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database, NewsletterScheduleRow } from '@/lib/db/types'
import type { MessagesApi } from '@/lib/marketing/generateCampaign'
import { generateForCampaign } from '@/lib/marketing/generateForCampaign'
import type { ScheduleBrief } from '@/lib/marketing/prompt'
import { createCampaign } from '@/lib/marketing/createCampaign'
import { findContract, type TemplateContract } from '@/lib/marketing/templateContracts'

import type { NewsletterScheduleOccurrenceRow } from '@/lib/db/scheduleOccurrenceTypes'

import { localDate } from './nextRun'
import {
  claimOccurrences,
  completeOccurrence,
  failOccurrence,
  recordDueOccurrences,
  retryOccurrence,
} from './occurrences'
import { sendReviewNotification } from './reviewEmail'

/**
 * Turns due newsletter schedules into campaigns waiting for approval.
 *
 * Called by the daily cron with the service-role client. Two phases (audit H12):
 *
 *   1. record: for each due schedule, record_newsletter_occurrences writes the due
 *      occurrence(s) and advances `next_run_at` in one transaction — conditional on it
 *      not having moved, so two overlapping runs cannot both record. Catch-up policy
 *      (decision 14.4): only the most recent missed occurrence is drafted; older ones
 *      are recorded as skipped, with a reason, and can be retried by a person;
 *   2. draft: occurrences are claimed with a lease and drafted one by one — template,
 *      campaign (the unique index on (schedule_id, scheduled_for) makes a repeat find
 *      the existing draft instead of making a second), copy, topic, review. A failure
 *      returns the occurrence to the queue with backoff, or marks it failed after its
 *      attempts, where the schedule list shows it with a Retry button.
 *
 * "Generate now" (runScheduleNow) drafts today's issue directly without an occurrence:
 * it never moves the schedule, so there is nothing to lose.
 *
 * It stops at review. Approval and sending stay with a person, and the database status
 * trigger would refuse anything else regardless.
 */

/** Generation takes tens of seconds; more than a few would outlast the function. */
export const MAX_SCHEDULES_PER_RUN = 3

/** Recording is cheap; this only bounds one run's reads. */
const MAX_SCHEDULES_RECORDED_PER_RUN = 50

/** How many past subjects the model is shown so it does not repeat itself. */
const RECENT_SUBJECT_COUNT = 5

type Db = SupabaseClient<Database>

export type RunDueDeps = {
  db: Db
  /** Null when ANTHROPIC_API_KEY is missing: the draft is still made, and flagged. */
  messages: MessagesApi | null
  now: Date
}

export type ScheduleRunReport = {
  scheduleId: string
  occurrenceId?: string
  scheduledFor?: string
  status: 'in_review' | 'needs_attention' | 'skipped' | 'failed'
  campaignId?: string
  reason?: string
  /** After a failure: back in the queue ('pending') or waiting for a person ('failed'). */
  occurrenceStatus?: 'pending' | 'failed' | 'lost'
  notification?: 'sent' | 'skipped' | 'failed'
}

export async function runDueSchedules(
  deps: RunDueDeps,
  limit = MAX_SCHEDULES_PER_RUN
): Promise<ScheduleRunReport[]> {
  const reports = await recordDue(deps)
  const claimed = await claimOccurrences(deps.db, { limit })

  // Sequential on purpose: each run holds a model call for tens of seconds, and running
  // them side by side would only race the function's time limit.
  for (const occurrence of claimed) {
    reports.push(await runOccurrence(deps, occurrence))
  }

  return reports
}

/** Phase 1. Reports only problems; recorded occurrences are reported when drafted. */
async function recordDue(deps: RunDueDeps): Promise<ScheduleRunReport[]> {
  const { data, error } = await deps.db
    .from('newsletter_schedules')
    .select('*')
    .eq('is_active', true)
    .is('archived_at', null)
    .lte('next_run_at', deps.now.toISOString())
    .order('next_run_at', { ascending: true })
    .limit(MAX_SCHEDULES_RECORDED_PER_RUN)

  if (error) throw new Error(`Could not read due schedules: ${error.message}`)

  const reports: ScheduleRunReport[] = []
  for (const schedule of (data ?? []) as NewsletterScheduleRow[]) {
    try {
      await recordDueOccurrences(deps.db, schedule, deps.now)
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError)
      console.error(`Newsletter schedule ${schedule.id} could not record its occurrence:`, message)
      reports.push({ scheduleId: schedule.id, status: 'failed', reason: message })
    }
  }
  return reports
}

/**
 * An operator's Retry: puts a failed or skipped occurrence back in the queue and drafts
 * it now, with the operator's own session.
 */
export async function retryAndRunOccurrence(deps: RunDueDeps, occurrenceId: string): Promise<ScheduleRunReport> {
  const queued = await retryOccurrence(deps.db, occurrenceId)
  const [claimed] = await claimOccurrences(deps.db, { limit: 1, occurrenceId })

  if (!claimed) {
    // Paused or archived schedule, or another run took it: it stays queued.
    return {
      scheduleId: queued.schedule_id,
      occurrenceId,
      scheduledFor: queued.scheduled_for,
      status: 'skipped',
      reason: 'queued',
    }
  }
  return runOccurrence(deps, claimed)
}

/**
 * Drafts the issue for one schedule now, without waiting for it to be due and without
 * moving its next run — the "Generate now" button. Dated today, so pressing it twice
 * in a day finds the first draft instead of making a second.
 */
export async function runScheduleNow(
  deps: RunDueDeps,
  schedule: NewsletterScheduleRow
): Promise<ScheduleRunReport> {
  try {
    const outcome = await draftIssue(deps, schedule, localDate(deps.now, schedule.timezone), false)
    return outcome.kind === 'done'
      ? outcome.report
      : { scheduleId: schedule.id, status: 'failed', reason: outcome.reason }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Newsletter schedule ${schedule.id} failed:`, message)
    return { scheduleId: schedule.id, status: 'failed', reason: message }
  }
}

type ReportBase = Pick<ScheduleRunReport, 'scheduleId' | 'occurrenceId' | 'scheduledFor'>

/**
 * Phase 2, one claimed occurrence: draft it, then settle the lease either way. Exported
 * for the integration tests, which run their own fixture's occurrence in isolation.
 */
export async function runOccurrence(
  deps: RunDueDeps,
  occurrence: NewsletterScheduleOccurrenceRow
): Promise<ScheduleRunReport> {
  const base: ReportBase = {
    scheduleId: occurrence.schedule_id,
    occurrenceId: occurrence.id,
    scheduledFor: occurrence.scheduled_for,
  }

  try {
    const schedule = await loadSchedule(deps.db, occurrence.schedule_id)
    if (!schedule) return await settleFailure(deps, occurrence, base, 'schedule_missing', false)

    const outcome = await draftIssue(deps, schedule, occurrence.scheduled_for, true)
    if (outcome.kind === 'refused') return await settleFailure(deps, occurrence, base, outcome.reason, false)

    const campaignId = outcome.report.campaignId
    if (!campaignId) return await settleFailure(deps, occurrence, base, 'campaign_missing', true)
    if (!(await completeOccurrence(deps.db, occurrence, campaignId))) {
      return { ...outcome.report, ...base, occurrenceStatus: 'lost' }
    }
    return { ...outcome.report, ...base }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Newsletter occurrence ${occurrence.id} failed:`, message)
    return settleFailure(deps, occurrence, base, message, true)
  }
}

async function settleFailure(
  deps: RunDueDeps,
  occurrence: NewsletterScheduleOccurrenceRow,
  base: ReportBase,
  reason: string,
  retryable: boolean
): Promise<ScheduleRunReport> {
  let occurrenceStatus: ScheduleRunReport['occurrenceStatus']
  try {
    occurrenceStatus = await failOccurrence(deps.db, occurrence, reason, retryable)
  } catch (error) {
    // The lease expires and the occurrence is retried; nothing is lost.
    console.error(
      `Could not record the failure of occurrence ${occurrence.id}:`,
      error instanceof Error ? error.message : error
    )
  }
  return { ...base, status: 'failed', reason, occurrenceStatus }
}

async function loadSchedule(db: Db, scheduleId: string): Promise<NewsletterScheduleRow | null> {
  const { data, error } = await db.from('newsletter_schedules').select('*').eq('id', scheduleId).maybeSingle()
  if (error) throw new Error(`Could not read the schedule: ${error.message}`)
  return (data as NewsletterScheduleRow | null) ?? null
}

type DraftOutcome =
  | { kind: 'done'; report: ScheduleRunReport }
  | { kind: 'refused'; reason: 'template_unusable' | 'segment_archived' }

/**
 * Template, campaign, copy, review for one occurrence date. Safe to repeat: with
 * `resumeExisting`, an occurrence whose campaign already exists resumes it — still a
 * draft, its copy is written again; past draft, nothing is redone.
 */
async function draftIssue(
  deps: RunDueDeps,
  schedule: NewsletterScheduleRow,
  scheduledFor: string,
  resumeExisting: boolean
): Promise<DraftOutcome> {
  const template = await loadUsableTemplate(deps.db, schedule.template_id)
  if (!template) return { kind: 'refused', reason: 'template_unusable' }

  const drafted = await draftCampaign(deps.db, schedule, template, scheduledFor)
  if (drafted === 'segment_archived') return { kind: 'refused', reason: 'segment_archived' }
  if (drafted !== 'already_drafted') {
    return { kind: 'done', report: await writeAndSubmit(deps, schedule, drafted, scheduledFor) }
  }

  const existing = await findOccurrenceCampaign(deps.db, schedule.id, scheduledFor)
  if (resumeExisting && existing?.status === 'draft') {
    return { kind: 'done', report: await writeAndSubmit(deps, schedule, existing, scheduledFor) }
  }
  return {
    kind: 'done',
    report: { scheduleId: schedule.id, status: 'skipped', reason: 'already_drafted', campaignId: existing?.id },
  }
}

type ExistingCampaign = { id: string; name: string; status: string }

async function findOccurrenceCampaign(
  db: Db,
  scheduleId: string,
  scheduledFor: string
): Promise<ExistingCampaign | null> {
  const { data, error } = await db
    .from('campaigns')
    .select('id, name, status')
    .eq('schedule_id', scheduleId)
    .eq('scheduled_for', scheduledFor)
    .maybeSingle()
  if (error) throw new Error(`Could not read the occurrence's campaign: ${error.message}`)
  return (data as ExistingCampaign | null) ?? null
}

type UsableTemplate = { id: string; provider_automation_id: string; contract: TemplateContract }

/**
 * The schedule's template, if it can still send a newsletter. The database stops a
 * schedule being pointed at a courses template, but not the template itself being
 * moved to courses, archived or emptied afterwards — so it is checked every run.
 */
async function loadUsableTemplate(db: Db, templateId: string): Promise<UsableTemplate | null> {
  const { data, error } = await db
    .from('campaign_templates')
    .select('id, provider_automation_id, consent_stream, archived_at, contract_id, contract_version')
    .eq('id', templateId)
    .maybeSingle()

  if (error) throw new Error(`Could not load the template: ${error.message}`)

  if (
    !data ||
    data.archived_at ||
    data.consent_stream !== 'newsletter' ||
    !data.provider_automation_id?.trim()
  ) {
    return null
  }

  // Scheduled issues are written by the CRM's copy generator, which fills the legacy
  // seven-field contract. A Studio template gets its content from the Studio instead.
  const contract = findContract(data.contract_id, data.contract_version)
  if (!contract || contract.delivery !== 'legacy') return null

  return { id: data.id, provider_automation_id: data.provider_automation_id, contract }
}

type DraftedCampaign = { id: string; name: string }

/**
 * Names the reason instead of a campaign when this occurrence already has one, or when
 * the schedule's segment has been archived (the database refuses a draft for it).
 */
async function draftCampaign(
  db: Db,
  schedule: NewsletterScheduleRow,
  template: UsableTemplate,
  scheduledFor: string
): Promise<DraftedCampaign | 'already_drafted' | 'segment_archived'> {
  const outcome = await createCampaign(db, {
    name: `${schedule.name} — ${scheduledFor}`,
    segmentId: schedule.segment_id,
    source: {
      kind: 'resolved',
      templateId: template.id,
      automationId: template.provider_automation_id,
      stream: 'newsletter',
      contract: template.contract,
    },
    mergeFields: {},
    scheduleId: schedule.id,
    scheduledFor,
  })

  if (outcome.ok) return { id: outcome.campaign.id, name: outcome.campaign.name }
  if (outcome.reason === 'duplicate') return 'already_drafted'
  if (outcome.reason === 'segment_archived') return 'segment_archived'
  throw new Error(`Could not draft the campaign: ${outcome.message}`)
}

async function writeAndSubmit(
  deps: RunDueDeps,
  schedule: NewsletterScheduleRow,
  campaign: DraftedCampaign,
  scheduledFor: string
): Promise<ScheduleRunReport> {
  const topic = (await topicOfCampaign(deps.db, campaign.id)) ?? (await nextTopic(deps.db, schedule.id))
  const brief: ScheduleBrief = {
    goal: schedule.goal,
    tone: schedule.tone,
    cta: schedule.cta,
    mustInclude: schedule.must_include,
    avoid: schedule.avoid,
    topic: topic ? { title: topic.title, details: topic.details } : null,
    recentSubjects: await recentSubjects(deps.db, schedule.id, campaign.id),
  }

  const written = await writeCopy(deps, campaign.id, brief)

  if (written.ok) {
    if (topic) await markTopicUsed(deps.db, topic.id, campaign.id)
    await submitForReview(deps.db, campaign.id)
  } else {
    await flagForAttention(deps.db, campaign.id, written.error)
  }

  const notification = await notify({
    scheduleName: schedule.name,
    campaignId: campaign.id,
    campaignName: campaign.name,
    subject: written.ok ? written.subject : null,
    scheduledFor,
    topicTitle: topic?.title ?? null,
    generationError: written.ok ? null : written.error,
  })

  return {
    scheduleId: schedule.id,
    status: written.ok ? 'in_review' : 'needs_attention',
    campaignId: campaign.id,
    notification,
  }
}

type WriteResult = { ok: true; subject: string | null } | { ok: false; error: string }

async function writeCopy(deps: RunDueDeps, campaignId: string, brief: ScheduleBrief): Promise<WriteResult> {
  if (!deps.messages) {
    return { ok: false, error: 'ANTHROPIC_API_KEY is not configured, so copy cannot be generated.' }
  }

  try {
    const outcome = await generateForCampaign(deps.db, deps.messages, campaignId, brief)

    return outcome.ok
      ? { ok: true, subject: outcome.campaign.subject ?? null }
      : { ok: false, error: outcome.message }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

type QueuedTopic = { id: string; title: string; details: string | null }

/** The topic an earlier attempt already took for this campaign, so a retry keeps it. */
async function topicOfCampaign(db: Db, campaignId: string): Promise<QueuedTopic | null> {
  const { data, error } = await db
    .from('newsletter_topics')
    .select('id, title, details')
    .eq('campaign_id', campaignId)
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Could not read the campaign's topic: ${error.message}`)

  return (data as QueuedTopic | null) ?? null
}

async function nextTopic(db: Db, scheduleId: string): Promise<QueuedTopic | null> {
  const { data, error } = await db
    .from('newsletter_topics')
    .select('id, title, details')
    .eq('schedule_id', scheduleId)
    .is('used_at', null)
    .is('removed_at', null)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Could not read the topic queue: ${error.message}`)

  return (data as QueuedTopic | null) ?? null
}

async function recentSubjects(db: Db, scheduleId: string, excludeId: string): Promise<string[]> {
  const { data, error } = await db
    .from('campaigns')
    .select('subject')
    .eq('schedule_id', scheduleId)
    .neq('id', excludeId)
    .not('subject', 'is', null)
    .order('scheduled_for', { ascending: false })
    .limit(RECENT_SUBJECT_COUNT)

  // Worth having, not worth failing an issue over.
  if (error) return []

  return (data ?? [])
    .map((row) => row.subject)
    .filter((subject): subject is string => Boolean(subject?.trim()))
}

async function markTopicUsed(db: Db, topicId: string, campaignId: string): Promise<void> {
  const { error } = await db
    .from('newsletter_topics')
    .update({ used_at: new Date().toISOString(), campaign_id: campaignId })
    .eq('id', topicId)
    .is('used_at', null)

  if (error) throw new Error(`Could not mark the topic used: ${error.message}`)
}

async function submitForReview(db: Db, campaignId: string): Promise<void> {
  const { error } = await db
    .from('campaigns')
    .update({ status: 'in_review' })
    .eq('id', campaignId)
    .eq('status', 'draft')

  if (error) throw new Error(`Could not move the campaign to review: ${error.message}`)
}

async function flagForAttention(db: Db, campaignId: string, reason: string): Promise<void> {
  const { error } = await db
    .from('campaigns')
    .update({ notes: `Automatic copy generation failed: ${reason}` })
    .eq('id', campaignId)

  if (error) console.error(`Could not record the generation failure on ${campaignId}:`, error.message)
}

async function notify(
  notice: Parameters<typeof sendReviewNotification>[0]
): Promise<ScheduleRunReport['notification']> {
  try {
    return (await sendReviewNotification(notice)).status
  } catch (error) {
    // The draft is already in the CRM with its badge; a failed email must not undo it.
    console.error('Review notification failed:', error instanceof Error ? error.message : error)

    return 'failed'
  }
}

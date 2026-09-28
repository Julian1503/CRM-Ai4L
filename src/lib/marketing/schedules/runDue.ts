import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database, NewsletterScheduleRow } from '@/lib/db/types'
import { isArchiveRuleError } from '@/lib/lifecycle/lifecycle'
import type { MessagesApi } from '@/lib/marketing/generateCampaign'
import { generateForCampaign } from '@/lib/marketing/generateForCampaign'
import type { ScheduleBrief } from '@/lib/marketing/prompt'

import { advanceSchedule, localDate } from './nextRun'
import { sendReviewNotification } from './reviewEmail'

/**
 * Turns due newsletter schedules into campaigns waiting for approval.
 *
 * Called by the daily cron with the service-role client, and by "Generate now" with the
 * operator's. Per schedule:
 *
 *   1. claim the occurrence by advancing `next_run_at` — conditional on it not having
 *      moved, so two overlapping runs cannot both take it;
 *   2. draft a campaign on the schedule's (newsletter) template — the unique index on
 *      (schedule_id, scheduled_for) makes a repeat a no-op rather than a duplicate;
 *   3. write the copy through the same path as "Write copy with AI";
 *   4. move it to review and tell the reviewers.
 *
 * It stops at review. Approval and sending stay with a person, and the database status
 * trigger would refuse anything else regardless.
 */

/** Generation takes tens of seconds; more than a few would outlast the function. */
export const MAX_SCHEDULES_PER_RUN = 3

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
  status: 'in_review' | 'needs_attention' | 'skipped' | 'failed'
  campaignId?: string
  reason?: string
  notification?: 'sent' | 'skipped' | 'failed'
}

type Occurrence = { scheduledFor: string; nextRunAt: Date | null }

export async function runDueSchedules(
  deps: RunDueDeps,
  limit = MAX_SCHEDULES_PER_RUN
): Promise<ScheduleRunReport[]> {
  const { data, error } = await deps.db
    .from('newsletter_schedules')
    .select('*')
    .eq('is_active', true)
    .is('archived_at', null)
    .lte('next_run_at', deps.now.toISOString())
    .order('next_run_at', { ascending: true })
    .limit(limit)

  if (error) throw new Error(`Could not read due schedules: ${error.message}`)

  const reports: ScheduleRunReport[] = []

  // Sequential on purpose: each run holds a model call for tens of seconds, and running
  // them side by side would only race the function's time limit.
  for (const schedule of (data ?? []) as NewsletterScheduleRow[]) {
    reports.push(await runOne(deps, schedule))
  }

  return reports
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
  return runOne(deps, schedule, {
    scheduledFor: localDate(deps.now, schedule.timezone),
    nextRunAt: null,
  })
}

async function runOne(
  deps: RunDueDeps,
  schedule: NewsletterScheduleRow,
  forced?: Occurrence
): Promise<ScheduleRunReport> {
  const scheduleId = schedule.id

  try {
    const occurrence =
      forced ??
      advanceSchedule(new Date(schedule.next_run_at), schedule.frequency, schedule.timezone, deps.now)

    if (occurrence.nextRunAt && !(await claim(deps.db, schedule, occurrence.nextRunAt))) {
      return { scheduleId, status: 'skipped', reason: 'claimed_elsewhere' }
    }

    const template = await loadUsableTemplate(deps.db, schedule.template_id)

    if (!template) return { scheduleId, status: 'failed', reason: 'template_unusable' }

    const campaign = await draftCampaign(deps.db, schedule, template, occurrence.scheduledFor)

    if (campaign === 'already_drafted') return { scheduleId, status: 'skipped', reason: 'already_drafted' }
    if (campaign === 'segment_archived') return { scheduleId, status: 'failed', reason: 'segment_archived' }

    return await writeAndSubmit(deps, schedule, campaign, occurrence.scheduledFor)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    console.error(`Newsletter schedule ${scheduleId} failed:`, message)

    return { scheduleId, status: 'failed', reason: message }
  }
}

/** Advances `next_run_at`, but only if it still holds the value this run read. */
async function claim(db: Db, schedule: NewsletterScheduleRow, nextRunAt: Date): Promise<boolean> {
  const { data, error } = await db
    .from('newsletter_schedules')
    .update({ next_run_at: nextRunAt.toISOString(), updated_at: new Date().toISOString() })
    .eq('id', schedule.id)
    .eq('next_run_at', schedule.next_run_at)
    .select('id')

  if (error) throw new Error(`Could not claim the schedule: ${error.message}`)

  return (data ?? []).length > 0
}

type UsableTemplate = { id: string; provider_automation_id: string }

/**
 * The schedule's template, if it can still send a newsletter. The database stops a
 * schedule being pointed at a courses template, but not the template itself being
 * moved to courses, archived or emptied afterwards — so it is checked every run.
 */
async function loadUsableTemplate(db: Db, templateId: string): Promise<UsableTemplate | null> {
  const { data, error } = await db
    .from('campaign_templates')
    .select('id, provider_automation_id, consent_stream, archived_at')
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

  return { id: data.id, provider_automation_id: data.provider_automation_id }
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
  const { data, error } = await db
    .from('campaigns')
    .insert({
      name: `${schedule.name} — ${scheduledFor}`,
      segment_id: schedule.segment_id,
      template_id: template.id,
      provider_automation_id: template.provider_automation_id,
      consent_stream: 'newsletter',
      schedule_id: schedule.id,
      scheduled_for: scheduledFor,
      merge_fields: {},
    })
    .select('id, name')
    .single()

  if (error?.code === '23505') return 'already_drafted'
  if (isArchiveRuleError(error)) return 'segment_archived'
  if (error) throw new Error(`Could not draft the campaign: ${error.message}`)

  return data as DraftedCampaign
}

async function writeAndSubmit(
  deps: RunDueDeps,
  schedule: NewsletterScheduleRow,
  campaign: DraftedCampaign,
  scheduledFor: string
): Promise<ScheduleRunReport> {
  const topic = await nextTopic(deps.db, schedule.id)
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

async function nextTopic(db: Db, scheduleId: string): Promise<QueuedTopic | null> {
  const { data, error } = await db
    .from('newsletter_topics')
    .select('id, title, details')
    .eq('schedule_id', scheduleId)
    .is('used_at', null)
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

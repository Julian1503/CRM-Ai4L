'use client'

import { useCallback, useEffect, useState } from 'react'

import LifecycleActions from '@/components/ui/LifecycleActions'
import type { CampaignTemplateRow, NewsletterScheduleRow } from '@/lib/db/types'

import styles from './marketing.module.css'
import NewsletterScheduleForm, {
  FREQUENCY_LABELS,
  type Option,
  type ScheduleDraft,
} from './NewsletterScheduleForm'
import NewsletterTopicQueue from './NewsletterTopicQueue'

type Schedule = Pick<
  NewsletterScheduleRow,
  'id' | 'name' | 'frequency' | 'next_run_at' | 'timezone' | 'goal' | 'is_active'
>

type RunReport = { status: 'in_review' | 'needs_attention'; campaignId: string }

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

function formatNextRun(schedule: Schedule): string {
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: schedule.timezone,
  }).format(new Date(schedule.next_run_at))
}

function describeRun(run: RunReport): string {
  return run.status === 'in_review'
    ? 'Drafted and waiting for approval. Find it in the campaign list above.'
    : 'Drafted, but its copy could not be written. Open it in the campaign list to see why.'
}

/**
 * Recurring newsletters.
 *
 * A schedule drafts one campaign per occurrence and leaves it in review: someone still
 * approves it and presses Send. Newsletter templates only — course and training email
 * stays hand-made.
 */
export default function NewsletterSchedules() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [templates, setTemplates] = useState<Option[]>([])
  const [segments, setSegments] = useState<Option[]>([])
  const [openTopics, setOpenTopics] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [scheduleResponse, templateResponse, segmentResponse] = await Promise.all([
        fetch('/api/newsletter-schedules'),
        fetch('/api/templates'),
        fetch('/api/segments?pageSize=200'),
      ])

      if (!scheduleResponse.ok) throw new Error(await readError(scheduleResponse))

      setSchedules((await scheduleResponse.json()).schedules ?? [])

      if (templateResponse.ok) {
        const loaded: CampaignTemplateRow[] = (await templateResponse.json()).templates ?? []
        setTemplates(loaded.filter((template) => template.consent_stream === 'newsletter'))
      }
      if (segmentResponse.ok) setSegments((await segmentResponse.json()).segments ?? [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load schedules.')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  /** Runs a request, reloads on success, and reports either way. */
  const act = async (key: string, request: () => Promise<Response>): Promise<unknown> => {
    setError(null)
    setNotice(null)
    setBusy(key)

    try {
      const response = await request()
      if (!response.ok) throw new Error(await readError(response))
      const body = await response.json().catch(() => ({}))
      await load()
      return body
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : 'The request failed.')
      return null
    } finally {
      setBusy(null)
    }
  }

  const create = async (draft: ScheduleDraft) =>
    (await act('create', () =>
      fetch('/api/newsletter-schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
    )) !== null

  const patch = (schedule: Schedule, change: Record<string, unknown>) =>
    act(schedule.id, () =>
      fetch(`/api/newsletter-schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      })
    )

  const runNow = async (schedule: Schedule) => {
    const body = (await act(schedule.id, () =>
      fetch(`/api/newsletter-schedules/${schedule.id}/run`, { method: 'POST' })
    )) as { run?: RunReport } | null

    if (body?.run) setNotice(describeRun(body.run))
  }

  return (
    <section className={styles.panel} aria-labelledby="schedules-heading">
      <h2 id="schedules-heading" className={styles.panelTitle}>
        Recurring newsletters
      </h2>
      <p className={styles.panelHint}>
        Each schedule drafts a newsletter on its own, writes the copy from your brief and
        the next queued topic, and emails the reviewers. Nothing is sent until someone
        approves it and presses Send.
      </p>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className={styles.checkOk} role="status">
          {notice}
        </p>
      )}

      <NewsletterScheduleForm
        templates={templates}
        segments={segments}
        busy={busy === 'create'}
        onCreate={create}
      />

      <ul className={styles.list}>
        {schedules.length === 0 && <li className={styles.empty}>No recurring newsletters yet.</li>}
        {schedules.map((schedule) => (
          <li key={schedule.id} className={styles.campaignItem} data-testid={`schedule-${schedule.id}`}>
            <div className={styles.campaignMain}>
              <span className={styles.itemName}>
                {schedule.name}{' '}
                <span className={`${styles.status} ${schedule.is_active ? styles.status_approved : styles.status_draft}`}>
                  {schedule.is_active ? 'Active' : 'Paused'}
                </span>
              </span>
              <span className={styles.itemMeta}>
                {FREQUENCY_LABELS[schedule.frequency]} · next draft{' '}
                <span data-testid={`schedule-next-${schedule.id}`}>{formatNextRun(schedule)}</span>
              </span>
              <span className={styles.itemMeta}>{schedule.goal}</span>
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => setOpenTopics(openTopics === schedule.id ? null : schedule.id)}
                aria-expanded={openTopics === schedule.id}
                data-testid={`topics-schedule-${schedule.id}`}
              >
                Topics
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => runNow(schedule)}
                disabled={busy !== null}
                data-testid={`run-schedule-${schedule.id}`}
              >
                {busy === schedule.id ? 'Working…' : 'Generate now'}
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => patch(schedule, { isActive: !schedule.is_active })}
                disabled={busy !== null}
                data-testid={`toggle-schedule-${schedule.id}`}
              >
                {schedule.is_active ? 'Pause' : 'Resume'}
              </button>
              {/* Archived schedules leave this list; they are restored from Archive. */}
              <LifecycleActions
                endpoint={`/api/newsletter-schedules/${schedule.id}`}
                noun="schedule"
                name={schedule.name}
                archived={false}
                onChanged={load}
                testId={`schedule-${schedule.id}`}
              />
            </div>

            {openTopics === schedule.id && <NewsletterTopicQueue scheduleId={schedule.id} />}
          </li>
        ))}
      </ul>
    </section>
  )
}

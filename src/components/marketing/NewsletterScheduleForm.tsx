'use client'

import { useState } from 'react'

import type { NewsletterFrequency } from '@/lib/db/types'

import styles from './marketing.module.css'

export type Option = { id: string; name: string }

export type ScheduleDraft = {
  name: string
  templateId: string
  segmentId: string
  frequency: NewsletterFrequency
  firstRunDate: string
  sendTime: string
  goal: string
  tone: string
  cta: string
  mustInclude: string
  avoid: string
}

const EMPTY: ScheduleDraft = {
  name: '',
  templateId: '',
  segmentId: '',
  frequency: 'monthly',
  firstRunDate: '',
  sendTime: '08:00',
  goal: '',
  tone: '',
  cta: '',
  mustInclude: '',
  avoid: '',
}

export const FREQUENCY_LABELS: Record<NewsletterFrequency, string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
}

/** The brief fields, in the order an operator thinks about them. */
const BRIEF_FIELDS: Array<{ key: keyof ScheduleDraft; label: string; placeholder: string }> = [
  { key: 'tone', label: 'Tone', placeholder: 'Warm, practical, no jargon' },
  { key: 'cta', label: 'Call to action', placeholder: 'Book a free consultation' },
  { key: 'mustInclude', label: 'Must include', placeholder: 'Dates, figures or links every issue needs' },
  { key: 'avoid', label: 'Avoid', placeholder: 'Topics or phrases to stay away from' },
]

type Props = {
  templates: Option[]
  segments: Option[]
  busy: boolean
  onCreate: (draft: ScheduleDraft) => Promise<boolean>
}

/**
 * The schedule and its brief.
 *
 * The goal is the one required part of the brief: it is what every issue is for, and
 * without it the model has nothing to aim at. Topics are queued separately, per schedule.
 */
export default function NewsletterScheduleForm({ templates, segments, busy, onCreate }: Props) {
  const [draft, setDraft] = useState<ScheduleDraft>(EMPTY)

  const set = (key: keyof ScheduleDraft) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const ready =
    draft.name.trim() &&
    draft.templateId &&
    draft.segmentId &&
    draft.firstRunDate &&
    draft.sendTime &&
    draft.goal.trim()

  const submit = async () => {
    if (await onCreate(draft)) setDraft(EMPTY)
  }

  return (
    <>
      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            className={styles.input}
            value={draft.name}
            onChange={(event) => set('name')(event.target.value)}
            placeholder="Monthly newsletter"
            data-testid="schedule-name"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Newsletter template</span>
          <select
            className={styles.input}
            value={draft.templateId}
            onChange={(event) => set('templateId')(event.target.value)}
            data-testid="schedule-template"
          >
            <option value="">Choose a template</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
          {templates.length === 0 && (
            <span className={styles.fieldHint}>
              Register a template for Newsletter subscribers under Integrations first.
            </span>
          )}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Segment</span>
          <select
            className={styles.input}
            value={draft.segmentId}
            onChange={(event) => set('segmentId')(event.target.value)}
            data-testid="schedule-segment"
          >
            <option value="">Choose a segment</option>
            {segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.label}>Frequency</span>
          <select
            className={styles.input}
            value={draft.frequency}
            onChange={(event) => set('frequency')(event.target.value)}
            data-testid="schedule-frequency"
          >
            {(Object.keys(FREQUENCY_LABELS) as NewsletterFrequency[]).map((frequency) => (
              <option key={frequency} value={frequency}>
                {FREQUENCY_LABELS[frequency]}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>First issue</span>
          <input
            type="date"
            className={styles.input}
            value={draft.firstRunDate}
            onChange={(event) => set('firstRunDate')(event.target.value)}
            data-testid="schedule-date"
          />
          {draft.frequency === 'monthly' && (
            <span className={styles.fieldHint}>Monthly issues fall between the 1st and the 28th.</span>
          )}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Drafted at (Sydney time)</span>
          <input
            type="time"
            className={styles.input}
            value={draft.sendTime}
            onChange={(event) => set('sendTime')(event.target.value)}
            data-testid="schedule-time"
          />
          <span className={styles.fieldHint}>
            The daily check runs once each morning; the draft appears then.
          </span>
        </label>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Goal of every issue</span>
        <textarea
          className={`${styles.input} ${styles.textarea}`}
          value={draft.goal}
          onChange={(event) => set('goal')(event.target.value)}
          rows={2}
          placeholder="Keep training managers up to date on practical AI, and bring them back to book a consultation."
          data-testid="schedule-goal"
        />
      </label>

      <div className={styles.formRow}>
        {BRIEF_FIELDS.map((field) => (
          <label key={field.key} className={styles.field}>
            <span className={styles.label}>{field.label}</span>
            <input
              className={styles.input}
              value={draft[field.key]}
              onChange={(event) => set(field.key)(event.target.value)}
              placeholder={field.placeholder}
              data-testid={`schedule-${field.key === 'mustInclude' ? 'must-include' : field.key}`}
            />
          </label>
        ))}
      </div>

      <button
        type="button"
        className={styles.primaryBtn}
        onClick={submit}
        disabled={!ready || busy}
        data-testid="create-schedule"
      >
        {busy ? 'Saving…' : 'Create schedule'}
      </button>
    </>
  )
}

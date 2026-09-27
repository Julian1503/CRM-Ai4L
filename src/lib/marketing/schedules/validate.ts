import type { NewsletterFrequency, NewsletterScheduleRow, NewsletterTopicRow } from '@/lib/db/types'

import { zonedToUtc } from './nextRun'

/**
 * Request validation for schedules and topics.
 *
 * Pure, so every rule is unit-tested here and the routes stay thin. Returns the column
 * shape to write, or the message to answer 400 with.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export const DEFAULT_TIMEZONE = 'Australia/Sydney'

const FREQUENCIES: NewsletterFrequency[] = ['weekly', 'fortnightly', 'monthly']

/** Brief fields end up in the model prompt; a pasted document would crowd out the rest. */
const MAX_TEXT = 2000
const MAX_NAME = 120

/** Days every month has, so a monthly issue never has to move. */
const MAX_MONTHLY_DAY = 28

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

type ScheduleColumns = Pick<
  NewsletterScheduleRow,
  | 'name'
  | 'template_id'
  | 'segment_id'
  | 'frequency'
  | 'timezone'
  | 'next_run_at'
  | 'goal'
  | 'tone'
  | 'cta'
  | 'must_include'
  | 'avoid'
  | 'is_active'
  | 'archived_at'
>

type Mode = 'create' | 'update'

class InvalidInput extends Error {}

function fail(message: string): never {
  throw new InvalidInput(message)
}

function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value)

  if (!match) return false

  const [, year, month, day] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function requiredText(body: Record<string, unknown>, key: string, label: string, max: number) {
  const value = typeof body[key] === 'string' ? (body[key] as string).trim() : ''

  if (!value) fail(`${label} is required.`)
  if (value.length > max) fail(`${label} must be at most ${max} characters.`)

  return value
}

function optionalText(body: Record<string, unknown>, key: string, label: string): string | null {
  const raw = body[key]

  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') fail(`${label} must be text.`)

  const value = raw.trim()

  if (value.length > MAX_TEXT) fail(`${label} must be at most ${MAX_TEXT} characters.`)

  return value || null
}

function readNextRun(
  body: Record<string, unknown>,
  frequency: NewsletterFrequency | undefined,
  timezone: string
): string {
  const date = typeof body.firstRunDate === 'string' ? body.firstRunDate.trim() : ''
  const time = typeof body.sendTime === 'string' ? body.sendTime.trim() : ''

  if (!isRealDate(date)) fail('Choose a valid first date (YYYY-MM-DD).')
  if (!TIME_PATTERN.test(time)) fail('Choose a valid send time (HH:MM, 24-hour).')

  if (frequency === 'monthly' && Number(date.slice(8, 10)) > MAX_MONTHLY_DAY) {
    fail(`A monthly newsletter must fall between the 1st and the ${MAX_MONTHLY_DAY}th.`)
  }

  return zonedToUtc(date, time, timezone).toISOString()
}

function readSchedule(body: Record<string, unknown>, mode: Mode): Partial<ScheduleColumns> {
  const has = (key: string) => mode === 'create' || body[key] !== undefined
  const out: Partial<ScheduleColumns> = {}

  if (has('name')) out.name = requiredText(body, 'name', 'A name', MAX_NAME)
  if (has('templateId')) out.template_id = requiredText(body, 'templateId', 'A template', MAX_NAME)
  if (has('segmentId')) out.segment_id = requiredText(body, 'segmentId', 'A segment', MAX_NAME)
  if (has('goal')) out.goal = requiredText(body, 'goal', 'The goal', MAX_TEXT)

  if (has('frequency')) {
    if (!FREQUENCIES.includes(body.frequency as NewsletterFrequency)) {
      fail('Frequency must be weekly, fortnightly or monthly.')
    }
    out.frequency = body.frequency as NewsletterFrequency
  }

  if (has('timezone')) {
    const zone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : DEFAULT_TIMEZONE
    if (!isKnownZone(zone)) fail(`Unknown time zone "${zone}".`)
    out.timezone = zone
  }

  if (has('firstRunDate') || has('sendTime')) {
    out.next_run_at = readNextRun(body, out.frequency, out.timezone ?? DEFAULT_TIMEZONE)
  }

  for (const [key, column, label] of [
    ['tone', 'tone', 'Tone'],
    ['cta', 'cta', 'Call to action'],
    ['mustInclude', 'must_include', 'Must include'],
    ['avoid', 'avoid', 'Avoid'],
  ] as const) {
    if (has(key)) out[column] = optionalText(body, key, label)
  }

  if (mode === 'update' && typeof body.isActive === 'boolean') out.is_active = body.isActive
  if (mode === 'update' && typeof body.archived === 'boolean') {
    out.archived_at = body.archived ? new Date().toISOString() : null
  }

  return out
}

export function parseScheduleInput(
  body: Record<string, unknown>,
  mode: 'create'
): Parsed<Omit<ScheduleColumns, 'is_active' | 'archived_at'>>
export function parseScheduleInput(
  body: Record<string, unknown>,
  mode: 'update'
): Parsed<Partial<ScheduleColumns>>
export function parseScheduleInput(
  body: Record<string, unknown>,
  mode: Mode
): Parsed<Partial<ScheduleColumns>> {
  try {
    const value = readSchedule(body, mode)

    if (mode === 'update' && Object.keys(value).length === 0) fail('Nothing to update.')

    return { ok: true, value }
  } catch (error) {
    if (error instanceof InvalidInput) return { ok: false, error: error.message }
    throw error
  }
}

type TopicColumns = Pick<NewsletterTopicRow, 'title' | 'details' | 'position'>

export function parseTopicInput(
  body: Record<string, unknown>,
  mode: Mode
): Parsed<Partial<TopicColumns>> {
  try {
    const has = (key: string) => mode === 'create' || body[key] !== undefined
    const value: Partial<TopicColumns> = {}

    if (has('title')) value.title = requiredText(body, 'title', 'A topic title', MAX_NAME * 2)
    if (has('details')) value.details = optionalText(body, 'details', 'Details')

    if (body.position !== undefined) {
      if (!Number.isInteger(body.position)) fail('Position must be a whole number.')
      value.position = body.position as number
    }

    if (mode === 'update' && Object.keys(value).length === 0) fail('Nothing to update.')

    return { ok: true, value }
  } catch (error) {
    if (error instanceof InvalidInput) return { ok: false, error: error.message }
    throw error
  }
}

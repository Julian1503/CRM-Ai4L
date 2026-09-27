import type { NewsletterFrequency } from '@/lib/db/types'

/**
 * Schedule arithmetic, in the schedule's own time zone.
 *
 * A newsletter "every Monday at 8am" means 8am in Sydney, which is 22:00 UTC half the
 * year and 21:00 UTC the other half. So occurrences are counted on the local calendar
 * and converted to an instant only at the end — adding 7 × 24 hours to a UTC timestamp
 * would drift an hour at every daylight-saving change.
 *
 * Built on `Intl` rather than a date library: this is the only place the app needs
 * zone arithmetic, and the runtime already carries the tz database.
 */

const DAY_MS = 24 * 60 * 60 * 1000

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number }

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant)

  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value)

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  }
}

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const local = localParts(instant, timeZone)
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)

  return asUtc - Math.floor(instant.getTime() / 60_000) * 60_000
}

const pad = (value: number) => String(value).padStart(2, '0')

/** The instant a wall-clock time in `timeZone` falls on. `date` is YYYY-MM-DD, `time` HH:MM. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const wall = Date.UTC(year, month - 1, day, hour, minute)

  // Guess with the offset at the wall time read as UTC, then correct once: the offset
  // at the real instant can differ when a DST change falls between the two.
  const guess = wall - offsetAt(new Date(wall), timeZone)

  return new Date(wall - offsetAt(new Date(guess), timeZone))
}

/** The calendar date (YYYY-MM-DD) an instant falls on in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  const local = localParts(instant, timeZone)

  return `${local.year}-${pad(local.month)}-${pad(local.day)}`
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The occurrence after `current`, at the same local time. */
export function nextOccurrence(
  current: Date,
  frequency: NewsletterFrequency,
  timeZone: string
): Date {
  const local = localParts(current, timeZone)
  let next: Date

  if (frequency === 'monthly') {
    const month = local.month === 12 ? 1 : local.month + 1
    const year = local.month === 12 ? local.year + 1 : local.year
    // Clamped so a 31st does not overflow into the month after. The API only accepts
    // days 1–28 for monthly schedules, so this is a guard rather than a feature.
    const day = Math.min(local.day, daysInMonth(year, month))

    next = new Date(Date.UTC(year, month - 1, day))
  } else {
    const days = frequency === 'weekly' ? 7 : 14

    next = new Date(Date.UTC(local.year, local.month - 1, local.day) + days * DAY_MS)
  }

  const date = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`

  return zonedToUtc(date, `${pad(local.hour)}:${pad(local.minute)}`, timeZone)
}

export type ScheduleAdvance = {
  /** The local date of the occurrence being claimed — the campaign's `scheduled_for`. */
  scheduledFor: string
  /** The first occurrence strictly after `now`. */
  nextRunAt: Date
}

/**
 * Claims the due occurrence and finds the next one.
 *
 * Skips every occurrence already in the past, so a schedule that was paused, or a cron
 * that did not run for a while, produces one issue on resume rather than a backlog of
 * stale ones.
 */
export function advanceSchedule(
  due: Date,
  frequency: NewsletterFrequency,
  timeZone: string,
  now: Date
): ScheduleAdvance {
  let nextRunAt = nextOccurrence(due, frequency, timeZone)

  while (nextRunAt.getTime() <= now.getTime()) {
    nextRunAt = nextOccurrence(nextRunAt, frequency, timeZone)
  }

  return { scheduledFor: localDate(due, timeZone), nextRunAt }
}

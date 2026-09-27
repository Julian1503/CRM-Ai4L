import { advanceSchedule, localDate, nextOccurrence, zonedToUtc } from './nextRun'

const SYDNEY = 'Australia/Sydney'

describe('zonedToUtc', () => {
  it('converts a Sydney wall-clock time in winter (AEST, +10)', () => {
    expect(zonedToUtc('2026-07-01', '08:00', SYDNEY).toISOString()).toBe('2026-06-30T22:00:00.000Z')
  })

  it('converts a Sydney wall-clock time in summer (AEDT, +11)', () => {
    expect(zonedToUtc('2026-12-01', '08:00', SYDNEY).toISOString()).toBe('2026-11-30T21:00:00.000Z')
  })
})

describe('localDate', () => {
  it('reads the calendar date in the schedule zone, not UTC', () => {
    // 22:00 UTC on the 30th is already the 1st in Sydney.
    expect(localDate(new Date('2026-06-30T22:00:00Z'), SYDNEY)).toBe('2026-07-01')
  })
})

describe('nextOccurrence', () => {
  it('adds a week', () => {
    const next = nextOccurrence(new Date('2026-07-01T22:00:00Z'), 'weekly', SYDNEY)
    expect(next.toISOString()).toBe('2026-07-08T22:00:00.000Z')
  })

  it('adds two weeks', () => {
    const next = nextOccurrence(new Date('2026-07-01T22:00:00Z'), 'fortnightly', SYDNEY)
    expect(next.toISOString()).toBe('2026-07-15T22:00:00.000Z')
  })

  it('keeps the same day of the month', () => {
    const next = nextOccurrence(new Date('2026-07-14T22:00:00Z'), 'monthly', SYDNEY)
    // 15 July local → 15 August local, 08:00 both times.
    expect(localDate(next, SYDNEY)).toBe('2026-08-15')
  })

  it('keeps the local hour across the start of daylight saving', () => {
    // Sydney moves to +11 on 4 October 2026. 08:00 local must stay 08:00 local, which
    // means the UTC instant moves an hour earlier.
    const before = zonedToUtc('2026-09-30', '08:00', SYDNEY)
    const after = nextOccurrence(before, 'weekly', SYDNEY)

    expect(after.toISOString()).toBe(zonedToUtc('2026-10-07', '08:00', SYDNEY).toISOString())
    expect(after.getTime() - before.getTime()).toBe(7 * 24 * 3600 * 1000 - 3600 * 1000)
  })

  it('rolls into the next year', () => {
    const next = nextOccurrence(zonedToUtc('2026-12-10', '08:00', SYDNEY), 'monthly', SYDNEY)
    expect(localDate(next, SYDNEY)).toBe('2027-01-10')
  })
})

describe('advanceSchedule', () => {
  it('claims the due occurrence and moves to the next one', () => {
    const due = zonedToUtc('2026-10-01', '08:00', SYDNEY)
    const now = new Date(due.getTime() + 60_000)

    expect(advanceSchedule(due, 'weekly', SYDNEY, now)).toEqual({
      scheduledFor: '2026-10-01',
      nextRunAt: zonedToUtc('2026-10-08', '08:00', SYDNEY),
    })
  })

  it('skips missed occurrences instead of drafting a backlog', () => {
    // A schedule paused for two months must produce one issue on resume, not eight.
    const due = zonedToUtc('2026-08-01', '08:00', SYDNEY)
    const now = zonedToUtc('2026-10-02', '09:00', SYDNEY)

    const { nextRunAt } = advanceSchedule(due, 'weekly', SYDNEY, now)

    expect(nextRunAt.getTime()).toBeGreaterThan(now.getTime())
    expect(nextRunAt.getTime() - now.getTime()).toBeLessThanOrEqual(7 * 24 * 3600 * 1000)
  })
})

import {
  CHECKOUT_STALE_HOURS,
  MAX_FLAGGED_IDS,
  NEEDS_ACTION_LABELS,
  NEEDS_ACTION_REASONS,
  PAID_FOLLOW_UP_HOURS,
  needsActionCutoffs,
  needsActionOrExpression,
  needsActionReasons,
  safeIds,
} from './needsAction'

const NOW = Date.parse('2026-10-12T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString()
const ID = '3f2a9c74-5b1e-4d8a-9f60-7c21ab4e0d53'
const NONE = { unmatchedCalendly: new Set<string>(), emailFailed: new Set<string>() }

function booking(overrides: Partial<Parameters<typeof needsActionReasons>[0]> = {}) {
  return { id: ID, status: 'paid' as const, updated_at: ago(1), consumed_at: ago(2), ...overrides }
}

describe('needsActionCutoffs', () => {
  it('turns the thresholds into instants', () => {
    expect(needsActionCutoffs(NOW)).toEqual({
      paidBefore: ago(PAID_FOLLOW_UP_HOURS),
      checkoutBefore: ago(CHECKOUT_STALE_HOURS),
    })
  })
})

describe('needsActionReasons', () => {
  const cutoffs = needsActionCutoffs(NOW)

  it('flags a claim with no time chosen only after the follow-up window', () => {
    expect(needsActionReasons(booking({ updated_at: ago(PAID_FOLLOW_UP_HOURS - 1) }), cutoffs, NONE)).toEqual([])
    expect(needsActionReasons(booking({ updated_at: ago(PAID_FOLLOW_UP_HOURS + 1) }), cutoffs, NONE)).toEqual(['stalled_claim'])
  })

  it('flags a checkout left open past its window', () => {
    const open = booking({ status: 'checkout_started', updated_at: ago(30) })
    expect(needsActionReasons({ ...open, consumed_at: ago(CHECKOUT_STALE_HOURS - 1) }, cutoffs, NONE)).toEqual([])
    expect(needsActionReasons({ ...open, consumed_at: ago(CHECKOUT_STALE_HOURS + 1) }, cutoffs, NONE)).toEqual(['stalled_checkout'])
    expect(needsActionReasons({ ...open, consumed_at: null }, cutoffs, NONE)).toEqual([])
  })

  it('never flags a scheduled, cancelled or expired booking on time alone', () => {
    for (const status of ['booked', 'cancelled', 'expired', 'pending'] as const) {
      expect(needsActionReasons(booking({ status, updated_at: ago(100), consumed_at: ago(100) }), cutoffs, NONE)).toEqual([])
    }
  })

  it('adds the reasons other tables report, whatever the status', () => {
    const flagged = { unmatchedCalendly: new Set([ID]), emailFailed: new Set([ID]) }
    expect(needsActionReasons(booking({ status: 'booked' }), cutoffs, flagged)).toEqual(['unmatched_calendly', 'email_failed'])
  })
})

describe('needsActionOrExpression', () => {
  const cutoffs = needsActionCutoffs(NOW)

  it('selects the two time rules and the flagged ids, with quoted instants', () => {
    expect(needsActionOrExpression(cutoffs, [ID])).toBe(
      `and(status.eq.paid,updated_at.lt."${cutoffs.paidBefore}"),` +
        `and(status.eq.checkout_started,consumed_at.lt."${cutoffs.checkoutBefore}"),` +
        `id.in.(${ID})`
    )
  })

  it('leaves the id clause out when nothing is flagged, and drops anything not shaped like an id', () => {
    const expression = needsActionOrExpression(cutoffs, ['x),status.eq.booked', ''])
    expect(expression).not.toContain('id.in')
    expect(expression).not.toContain('booked')
  })
})

describe('safeIds', () => {
  it('dedupes, filters to UUIDs and caps the list', () => {
    expect(safeIds([ID, ID, 'nope'])).toEqual([ID])
    const many = Array.from({ length: MAX_FLAGGED_IDS + 5 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    expect(safeIds(many)).toHaveLength(MAX_FLAGGED_IDS)
  })
})

describe('NEEDS_ACTION_LABELS', () => {
  it('explains every reason in plain words, without webhook names', () => {
    for (const reason of NEEDS_ACTION_REASONS) {
      expect(NEEDS_ACTION_LABELS[reason].label).toBeTruthy()
      expect(NEEDS_ACTION_LABELS[reason].hint).not.toMatch(/invitee\.created|webhook/i)
    }
  })
})

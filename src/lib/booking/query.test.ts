/**
 * @jest-environment node
 */
import {
  BOOKING_STATUS_HINTS,
  BOOKING_STATUS_LABELS,
  BOOKING_STATUSES,
  emptyBookingStatusCounts,
  formatAmountCents,
  getBookingPageRange,
  hasSettledPayment,
  isBookingStatus,
  parseBookingFilters,
} from './query'

function params(query: string): URLSearchParams {
  return new URLSearchParams(query)
}

describe('parseBookingFilters', () => {
  it('defaults to newest first with no status filter', () => {
    const filters = parseBookingFilters(params(''))

    expect(filters.status).toBeNull()
    expect(filters.sort).toBe('created')
    expect(filters.dir).toBe('desc')
    expect(filters.page).toBe(1)
  })

  it('accepts each real booking status', () => {
    for (const status of BOOKING_STATUSES) {
      expect(parseBookingFilters(params(`status=${status}`)).status).toBe(status)
    }
  })

  it('discards a status that is not in the enum', () => {
    // This value reaches a query builder. Passing it through would let a crafted query
    // string filter on a column value the schema does not have.
    expect(parseBookingFilters(params('status=archived')).status).toBeNull()
    expect(parseBookingFilters(params('status=paid,or,1=1')).status).toBeNull()
  })

  it('discards a sort key that is not whitelisted', () => {
    expect(parseBookingFilters(params('sort=token_hash')).sort).toBe('created')
  })

  it('reads a campaign id so a campaign can be measured on its own', () => {
    expect(parseBookingFilters(params('campaignId=camp-1')).campaignId).toBe('camp-1')
  })

  it('clamps the page size rather than trusting it', () => {
    expect(parseBookingFilters(params('pageSize=100000')).pageSize).toBe(200)
  })

  it('falls back on an unparseable page rather than erroring', () => {
    expect(parseBookingFilters(params('page=abc')).page).toBe(1)
  })
})

describe('getBookingPageRange', () => {
  it('produces an inclusive range for the requested page', () => {
    const filters = parseBookingFilters(params('page=3&pageSize=25'))

    expect(getBookingPageRange(filters)).toEqual({ from: 50, to: 74 })
  })
})

describe('isBookingStatus', () => {
  it('rejects non-strings', () => {
    expect(isBookingStatus(null)).toBe(false)
    expect(isBookingStatus(7)).toBe(false)
  })
})

describe('status vocabulary', () => {
  it('labels and explains every status, so none renders as a raw enum value', () => {
    for (const status of BOOKING_STATUSES) {
      expect(BOOKING_STATUS_LABELS[status]).toBeTruthy()
      expect(BOOKING_STATUS_HINTS[status]).toBeTruthy()
    }
  })

  it('does not label paid as a completed booking', () => {
    // `paid` means the lead claimed the offer and never chose a time. Calling it
    // "Booked" would report a conversion that did not happen -- and would hide a
    // Calendly webhook outage, which parks every booking in exactly this state.
    expect(BOOKING_STATUS_LABELS.paid).not.toMatch(/booked/i)
    expect(BOOKING_STATUS_HINTS.paid).toMatch(/follow-up/i)
  })
})

describe('emptyBookingStatusCounts', () => {
  it('has a zero for every status, so a missing key cannot render as undefined', () => {
    const counts = emptyBookingStatusCounts()

    expect(Object.keys(counts).sort()).toEqual([...BOOKING_STATUSES].sort())
    expect(Object.values(counts).every((value) => value === 0)).toBe(true)
  })
})

describe('formatAmountCents', () => {
  it('renders the list price and the discounted price the client talks about', () => {
    expect(formatAmountCents(50_000)).toBe('$500')
    expect(formatAmountCents(0)).toBe('$0')
  })

  it('shows cents only when there are cents', () => {
    expect(formatAmountCents(12_345)).toBe('$123.45')
  })

  it('renders an em dash when nothing has settled yet', () => {
    // null is "Stripe has not confirmed", which is different from "charged nothing".
    // Rendering it as $0 would claim a completed $0 transaction that has not happened.
    expect(formatAmountCents(null)).toBe('—')
  })
})

describe('hasSettledPayment', () => {
  it('distinguishes a confirmed $0 charge from an unconfirmed one', () => {
    expect(hasSettledPayment({ charged_amount_cents: 0 })).toBe(true)
    expect(hasSettledPayment({ charged_amount_cents: null })).toBe(false)
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import BookingsView from './BookingsView'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

const BOOKED = {
  id: 'b1',
  status: 'booked' as const,
  list_amount_cents: 50_000,
  charged_amount_cents: 0,
  currency: 'AUD',
  scheduled_at: '2026-09-01T02:00:00.000Z',
  created_at: '2026-08-20T00:00:00.000Z',
  contact: { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
  campaign: { id: 'camp-1', name: 'RTO winter' },
}

const UNCONFIRMED = {
  ...BOOKED,
  id: 'b2',
  status: 'checkout_started' as const,
  charged_amount_cents: null,
  scheduled_at: null,
}

function counts(overrides: Partial<Record<string, number>> = {}) {
  return {
    pending: 0,
    checkout_started: 0,
    paid: 0,
    booked: 0,
    cancelled: 0,
    expired: 0,
    ...overrides,
  }
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function respondWith(body: unknown, ok = true, status = 200) {
  mockFetch.mockResolvedValue(jsonResponse(body, ok, status))
}

describe('BookingsView', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    respondWith({ bookings: [BOOKED], counts: counts({ booked: 1 }), total: 1 })
  })

  it('lists a booking with the contact and campaign it came from', async () => {
    render(<BookingsView />)

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByText('RTO winter')).toBeInTheDocument()
  })

  it('shows the $500 value alongside the $0 actually charged', async () => {
    // The offer the whole funnel is built on. Showing only "$0" loses the claim the
    // client is actually making to the lead.
    render(<BookingsView />)

    expect(await screen.findByText('$500')).toBeInTheDocument()
    expect(screen.getByTestId('booking-charged-b1')).toHaveTextContent('$0')
  })

  it('does not claim $0 was charged before Stripe confirms it', async () => {
    // charged_amount_cents is null until checkout.session.completed lands. Rendering
    // that as "$0" would report a completed transaction that has not happened.
    respondWith({
      bookings: [UNCONFIRMED],
      counts: counts({ checkout_started: 1 }),
      total: 1,
    })

    render(<BookingsView />)

    expect(await screen.findByTestId('booking-charged-b2')).toHaveTextContent('—')
  })

  it('translates the status enum into something an operator can read', async () => {
    render(<BookingsView />)

    await screen.findByText('Ada Lovelace')
    expect(screen.getByTestId('booking-b1')).toHaveTextContent('Booked')
    expect(screen.getByTestId('booking-b1')).not.toHaveTextContent('checkout_started')
  })

  it('summarises the funnel from the API counts, not from the visible page', async () => {
    respondWith({
      bookings: [BOOKED],
      counts: counts({ booked: 12, paid: 4, pending: 30 }),
      total: 46,
    })

    render(<BookingsView />)

    // Waiting on the *content*, not on the element: the summary strip renders from the
    // first paint showing zeros, so findByTestId resolves against that empty state and
    // races the fetch. Same trap PLAN.md records for the pagination summary.
    await waitFor(() => {
      expect(screen.getByTestId('bookings-summary')).toHaveTextContent('12')
    })

    expect(screen.getByTestId('bookings-summary')).toHaveTextContent('30')
  })

  it('warns when bookings are stalling at paid, which is what a Calendly outage looks like', async () => {
    respondWith({ bookings: [], counts: counts({ paid: 5 }), total: 0 })

    render(<BookingsView />)

    const notice = await screen.findByTestId('bookings-stalled-notice')
    expect(notice).toHaveTextContent('5 leads have claimed')
    expect(notice).toHaveTextContent('invitee.created')
  })

  it('stays quiet when nothing is stalled', async () => {
    render(<BookingsView />)

    await screen.findByText('Ada Lovelace')
    expect(screen.queryByTestId('bookings-stalled-notice')).not.toBeInTheDocument()
  })

  it('filters by status without asking for an "all" filter', async () => {
    render(<BookingsView />)
    await screen.findByText('Ada Lovelace')

    fireEvent.click(screen.getByTestId('bookings-tab-paid'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('status=paid'))
    })

    // "All" is a pseudo-tab, not a status the API knows about.
    expect(mockFetch.mock.calls[0][0]).not.toContain('status=')
  })

  it('returns to page one when the filter changes', async () => {
    render(<BookingsView />)
    await screen.findByText('Ada Lovelace')

    fireEvent.click(screen.getByTestId('bookings-tab-booked'))

    await waitFor(() => {
      const last = mockFetch.mock.calls.at(-1)![0] as string
      expect(last).toContain('page=1')
    })
  })

  it('explains the empty state in terms of how bookings are created', async () => {
    respondWith({ bookings: [], counts: counts(), total: 0 })

    render(<BookingsView />)

    expect(await screen.findByTestId('bookings-empty')).toHaveTextContent(
      /campaign is sent/i
    )
  })

  it('surfaces a load failure rather than showing an empty funnel', async () => {
    // An empty table and a failed request look identical, and one of them silently
    // claims no lead ever booked.
    respondWith({ error: 'denied' }, false, 500)

    render(<BookingsView />)

    expect(await screen.findByTestId('bookings-error')).toHaveTextContent('denied')
    expect(screen.queryByTestId('bookings-table')).not.toBeInTheDocument()
  })

  it('clears stale rows when a later request fails', async () => {
    const { rerender } = render(<BookingsView />)
    await screen.findByText('Ada Lovelace')

    respondWith({ error: 'gone' }, false, 500)
    fireEvent.click(screen.getByTestId('bookings-tab-paid'))

    await screen.findByTestId('bookings-error')
    rerender(<BookingsView />)

    await waitFor(() => {
      expect(screen.queryByText('RTO winter')).not.toBeInTheDocument()
    })
  })

  it('renders a contact that has since been removed without crashing', async () => {
    respondWith({
      bookings: [{ ...BOOKED, contact: null }],
      counts: counts({ booked: 1 }),
      total: 1,
    })

    render(<BookingsView />)

    expect(await screen.findByText('Contact removed')).toBeInTheDocument()
  })
})

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import BookingsView, { bookingsQuery } from './BookingsView'

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
  reasons: [] as string[],
}

const STALLED = {
  ...BOOKED,
  id: 'b2',
  status: 'paid' as const,
  scheduled_at: null,
  reasons: ['stalled_claim', 'email_failed'],
}

const UNCONFIRMED = { ...BOOKED, id: 'b3', status: 'checkout_started' as const, charged_amount_cents: null, scheduled_at: null }

function counts(overrides: Partial<Record<string, number>> = {}) {
  return { pending: 0, checkout_started: 0, paid: 0, booked: 0, cancelled: 0, expired: 0, ...overrides }
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function listResponse(overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    bookings: [STALLED],
    counts: counts({ booked: 3, paid: 2, pending: 1, checkout_started: 1, cancelled: 1, expired: 1 }),
    needsActionCount: 1,
    schedulingHealth: { delayed: false, unmatchedEvents: 0, failedDeliveries: 0 },
    total: 1,
    ...overrides,
  })
}

const lastQuery = () => new URLSearchParams(String(mockFetch.mock.calls.at(-1)?.[0]).split('?')[1])

describe('bookingsQuery', () => {
  it('sends only the filters in use, with local days as ISO bounds', () => {
    const base = { queue: 'all' as const, status: '' as const, search: '', dateField: 'created' as const, fromDay: '', toDay: '' }
    expect(bookingsQuery(base, 2, 25)).toBe('queue=all&page=2&pageSize=25')

    const query = new URLSearchParams(bookingsQuery({ ...base, status: 'paid', search: 'ada', dateField: 'scheduled', fromDay: '2026-10-01', toDay: '2026-10-01' }, 1, 50))
    expect(query.get('status')).toBe('paid')
    expect(query.get('q')).toBe('ada')
    expect(query.get('dateField')).toBe('scheduled')
    // The whole local day: from its start to the next day's start.
    expect(new Date(query.get('to')!).getTime() - new Date(query.get('from')!).getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('ignores malformed days', () => {
    const query = new URLSearchParams(
      bookingsQuery({ queue: 'all', status: '', search: '', dateField: 'created', fromDay: '2026-13-45', toDay: 'nope' }, 1, 50)
    )
    expect(query.get('from')).toBeNull()
    expect(query.get('dateField')).toBeNull()
  })
})

describe('BookingsView', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(listResponse())
  })

  it('opens on the Needs action queue and says why each booking is there', async () => {
    render(<BookingsView />)

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    expect(lastQuery().get('queue')).toBe('needs_action')
    expect(screen.getByTestId('bookings-queue-needs_action')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('bookings-queue-needs_action')).toHaveTextContent('Needs action 1')
    expect(screen.getByTestId('bookings-queue-all')).toHaveTextContent('All bookings 9')
    const row = screen.getByTestId('booking-b2')
    expect(within(row).getByText('No time chosen')).toBeInTheDocument()
    expect(within(row).getByText('Confirmation email failed')).toBeInTheDocument()
    expect(within(row).getByText('Choose a time')).toBeInTheDocument()
  })

  it('summarises the funnel from the API counts in one compact line', async () => {
    render(<BookingsView />)
    const summary = await screen.findByTestId('bookings-summary')
    await waitFor(() => expect(summary).toHaveTextContent('3 scheduled'))
    expect(summary).toHaveTextContent('2 claimed, no time chosen')
    expect(summary).toHaveTextContent('2 links not claimed yet')
    expect(summary).toHaveTextContent('2 cancelled or expired')
  })

  it('shows the $500 value and the $0 charged, and never claims $0 before Stripe confirms', async () => {
    mockFetch.mockResolvedValue(listResponse({ bookings: [BOOKED, UNCONFIRMED] }))
    render(<BookingsView />)

    expect(await screen.findByTestId('booking-charged-b1')).toHaveTextContent('$0')
    expect(screen.getAllByText('$500')).toHaveLength(2)
    expect(screen.getByTestId('booking-charged-b3')).toHaveTextContent('—')
    expect(within(screen.getByTestId('booking-b1')).getByText('—')).toBeInTheDocument()
  })

  it('switches to all bookings and filters by status, search and date range, from page one', async () => {
    render(<BookingsView />)
    await screen.findByText('Ada Lovelace')

    fireEvent.click(screen.getByTestId('bookings-queue-all'))
    await waitFor(() => expect(lastQuery().get('queue')).toBe('all'))

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'paid' } })
    await waitFor(() => expect(lastQuery().get('status')).toBe('paid'))

    fireEvent.change(screen.getByLabelText('Search bookings by name or email'), { target: { value: '  ada ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(lastQuery().get('q')).toBe('ada'))

    fireEvent.change(screen.getByLabelText('Date to filter by'), { target: { value: 'scheduled' } })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-07' } })
    await waitFor(() => expect(lastQuery().get('to')).not.toBeNull())
    expect(lastQuery().get('dateField')).toBe('scheduled')
    expect(lastQuery().get('page')).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(lastQuery().get('status')).toBeNull())
    expect(lastQuery().get('q')).toBeNull()
    expect(lastQuery().get('from')).toBeNull()
    expect(screen.getByLabelText('Search bookings by name or email')).toHaveValue('')
  })

  it('tells the operator scheduling updates are delayed, without webhook jargon', async () => {
    mockFetch.mockResolvedValue(listResponse({ schedulingHealth: { delayed: true, unmatchedEvents: 2, failedDeliveries: 1 } }))
    render(<BookingsView />)

    const notice = await screen.findByTestId('bookings-stalled-notice')
    expect(notice).toHaveTextContent('Scheduling updates are delayed.')
    expect(notice).toHaveTextContent('2 Calendly updates are waiting to be matched.')
    expect(notice).toHaveTextContent('1 update from Calendly failed in the last day.')
    expect(notice).not.toHaveTextContent(/invitee\.created|webhook/i)
    expect(within(notice).getByRole('link', { name: 'Open integration health' })).toHaveAttribute('href', '/settings?section=overview')
  })

  it('uses the page handler for integration health when given, and the singular wording', async () => {
    mockFetch.mockResolvedValue(listResponse({ schedulingHealth: { delayed: true, unmatchedEvents: 1, failedDeliveries: 2 } }))
    const onOpenIntegrationHealth = jest.fn()
    render(<BookingsView onOpenIntegrationHealth={onOpenIntegrationHealth} />)

    const notice = await screen.findByTestId('bookings-stalled-notice')
    expect(notice).toHaveTextContent('1 Calendly update is waiting to be matched.')
    expect(notice).toHaveTextContent('2 updates from Calendly failed')
    fireEvent.click(within(notice).getByRole('button', { name: 'Open integration health' }))
    expect(onOpenIntegrationHealth).toHaveBeenCalled()
  })

  it('stays quiet when scheduling is healthy or its health is unknown', async () => {
    mockFetch.mockResolvedValue(listResponse({ schedulingHealth: null }))
    render(<BookingsView />)
    await screen.findByText('Ada Lovelace')
    expect(screen.queryByTestId('bookings-stalled-notice')).not.toBeInTheDocument()
  })

  it('says when nothing needs action, and offers every booking', async () => {
    mockFetch.mockResolvedValue(listResponse({ bookings: [], needsActionCount: 0, total: 0 }))
    render(<BookingsView />)

    expect(await screen.findByTestId('bookings-empty')).toHaveTextContent('Nothing needs action right now.')
    fireEvent.click(screen.getByRole('button', { name: 'Show all bookings' }))
    await waitFor(() => expect(lastQuery().get('queue')).toBe('all'))
  })

  it('explains the empty state in terms of how bookings are created', async () => {
    mockFetch.mockResolvedValue(listResponse({ bookings: [], counts: counts(), needsActionCount: 0, total: 0 }))
    render(<BookingsView />)
    expect(await screen.findByTestId('bookings-empty')).toHaveTextContent(/created when a campaign is sent/)
  })

  it('offers to clear filters when they match nothing', async () => {
    render(<BookingsView />)
    await screen.findByText('Ada Lovelace')
    mockFetch.mockResolvedValue(listResponse({ bookings: [], total: 0 }))

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'expired' } })
    expect(await screen.findByTestId('bookings-empty')).toHaveTextContent('No bookings match these filters.')
    fireEvent.click(within(screen.getByTestId('bookings-empty')).getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(lastQuery().get('status')).toBeNull())
  })

  it('surfaces a load failure, clears stale rows and retries', async () => {
    render(<BookingsView />)
    await screen.findByText('Ada Lovelace')

    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'Database unavailable' }, false, 500))
    fireEvent.click(screen.getByTestId('bookings-queue-all'))

    expect(await screen.findByTestId('bookings-error')).toHaveTextContent('Database unavailable')
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
  })

  it('reports a failure without a message, and survives a body that is not JSON', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('html') } })
    render(<BookingsView />)
    expect(await screen.findByTestId('bookings-error')).toHaveTextContent('Could not load bookings.')
  })

  it('reports a network failure', async () => {
    mockFetch.mockRejectedValue('offline')
    render(<BookingsView />)
    expect(await screen.findByTestId('bookings-error')).toHaveTextContent('Could not load bookings.')
  })

  it('defaults missing response fields', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    render(<BookingsView />)
    expect(await screen.findByTestId('bookings-empty')).toBeInTheDocument()
    expect(screen.getByTestId('bookings-queue-needs_action')).toHaveTextContent('Needs action 0')
  })

  it('renders a contact that has since been removed', async () => {
    mockFetch.mockResolvedValue(listResponse({ bookings: [{ ...STALLED, contact: null, campaign: null }] }))
    render(<BookingsView />)
    expect(await screen.findByText('Contact removed')).toBeInTheDocument()
  })

  it('pages on the server and resets to page one on a page-size change', async () => {
    mockFetch.mockResolvedValue(listResponse({ total: 120 }))
    render(<BookingsView />)
    await screen.findByText('Ada Lovelace')

    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(lastQuery().get('page')).toBe('2'))

    fireEvent.change(screen.getByTestId('bookings-pagination-size'), { target: { value: '25' } })
    await waitFor(() => expect(lastQuery().get('pageSize')).toBe('25'))
    expect(lastQuery().get('page')).toBe('1')
  })

  it('opens the booking drawer from a row and closes it', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url.startsWith('/api/bookings/b2')
        ? jsonResponse({ booking: { ...STALLED, expires_at: '2026-10-30T00:00:00.000Z', stripe_session_id: null, calendly_event_uri: null }, reasons: [], timeline: [] })
        : listResponse()
    )
    render(<BookingsView />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open booking for Ada Lovelace' }))
    expect(await screen.findByRole('dialog', { name: 'Ada Lovelace' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close booking details' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { ToastProvider } from '@/components/ui/Toast'

import BookingDrawer, { CALENDLY_EVENTS_URL } from './BookingDrawer'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

const DETAIL = {
  booking: {
    id: 'b2',
    status: 'paid',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    expires_at: '2026-10-30T00:00:00.000Z',
    consumed_at: '2026-10-01T05:00:00.000Z',
    stripe_session_id: 'cs_test_1',
    calendly_event_uri: 'https://api.calendly.com/scheduled_events/e1',
    calendly_invitee_uri: null,
    calendly_superseded_invitees: [],
    scheduled_at: null,
    cancelled_at: null,
    list_amount_cents: 50_000,
    charged_amount_cents: 0,
    currency: 'AUD',
    contact: { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
    campaign: { id: 'k1', name: 'Spring offer' },
  },
  reasons: ['stalled_claim', 'unmatched_calendly'],
  timeline: [
    { key: 'created', at: '2026-10-01T00:00:00.000Z', title: 'Booking link sent', detail: 'Campaign: Spring offer', tone: 'neutral' },
    { key: 'claimed', at: null, title: 'Free offer claimed — $0 charged', tone: 'success' },
  ],
}

function respond(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function renderDrawer(props: Partial<Parameters<typeof BookingDrawer>[0]> = {}) {
  const onClose = jest.fn()
  render(
    <ToastProvider>
      <button type="button">Opener</button>
      <BookingDrawer bookingId="b2" onClose={onClose} {...props} />
    </ToastProvider>
  )
  return { onClose }
}

describe('BookingDrawer', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(respond(DETAIL))
  })

  it('shows who, where it stands, why it needs action and its timeline', async () => {
    renderDrawer()

    expect(screen.getByRole('status')).toHaveTextContent('Loading booking…')
    const dialog = await screen.findByRole('dialog', { name: 'Ada Lovelace' })
    expect(mockFetch).toHaveBeenCalledWith('/api/bookings/b2')
    expect(within(dialog).getByText('Choose a time')).toBeInTheDocument()
    const attention = within(dialog).getByRole('region', { name: 'Needs action' })
    expect(attention).toHaveTextContent('No time chosen.')
    expect(attention).toHaveTextContent('Calendly update not matched.')
    expect(within(attention).getByRole('link', { name: 'Open integration health' })).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'ada@example.com' })).toHaveAttribute('href', 'mailto:ada@example.com')
    expect(within(dialog).getByText('Value').nextElementSibling).toHaveTextContent('$500 $0 charged')
    const timeline = within(dialog).getByRole('region', { name: 'Timeline' })
    expect(timeline).toHaveTextContent('Booking link sent')
    expect(timeline).toHaveTextContent('Campaign: Spring offer')
    expect(timeline).toHaveTextContent('Time not recorded')
  })

  it('offers only safe, read-only actions', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const onOpenContact = jest.fn()
    renderDrawer({ onOpenContact })
    const actions = within(await screen.findByRole('region', { name: 'Actions' }))

    fireEvent.click(actions.getByRole('button', { name: 'Open contact' }))
    expect(onOpenContact).toHaveBeenCalledWith('c1')

    fireEvent.click(actions.getByRole('button', { name: 'Copy email' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ada@example.com'))
    expect(await screen.findByTestId('toast-success')).toHaveTextContent('Email address copied.')

    fireEvent.click(actions.getByRole('button', { name: 'Copy Calendly event reference' }))
    fireEvent.click(actions.getByRole('button', { name: 'Copy Stripe checkout ID' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('cs_test_1'))
    expect(writeText).toHaveBeenCalledWith('https://api.calendly.com/scheduled_events/e1')

    const calendly = actions.getByRole('link', { name: 'Open Calendly ↗' })
    expect(calendly).toHaveAttribute('href', CALENDLY_EVENTS_URL)
    expect(calendly).toHaveAttribute('rel', 'noopener noreferrer')
    expect(actions.queryByRole('button', { name: /delete|remove|cancel|resend/i })).not.toBeInTheDocument()
  })

  it('reports a copy that fails', async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockRejectedValue(new Error('denied')) } })
    renderDrawer()
    fireEvent.click(await screen.findByRole('button', { name: 'Copy email' }))
    expect(await screen.findByTestId('toast-error')).toHaveTextContent('Could not copy the email address.')
  })

  it('leaves out actions with nothing to act on', async () => {
    mockFetch.mockResolvedValue(
      respond({ ...DETAIL, reasons: [], booking: { ...DETAIL.booking, contact: null, campaign: null, stripe_session_id: null, calendly_event_uri: null, charged_amount_cents: null } })
    )
    renderDrawer()

    const dialog = await screen.findByRole('dialog', { name: 'Contact removed' })
    expect(within(dialog).queryByRole('region', { name: 'Needs action' })).not.toBeInTheDocument()
    expect(within(dialog).getByText('Value').nextElementSibling).toHaveTextContent('not claimed yet')
    expect(within(dialog).getByRole('region', { name: 'Actions' })).toBeEmptyDOMElement()
  })

  it('uses the page handler for integration health when given', async () => {
    const onOpenIntegrationHealth = jest.fn()
    renderDrawer({ onOpenIntegrationHealth })
    fireEvent.click(await screen.findByRole('button', { name: 'Open integration health' }))
    expect(onOpenIntegrationHealth).toHaveBeenCalled()
  })

  it('reports a load failure and tries again', async () => {
    mockFetch.mockResolvedValueOnce(respond({ error: 'Booking not found.' }, false, 404))
    renderDrawer()

    expect(await screen.findByRole('alert')).toHaveTextContent('Booking not found.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('dialog', { name: 'Ada Lovelace' })).toBeInTheDocument()
  })

  it.each([
    [{ ok: false, status: 500, json: async () => { throw new Error('html') } }],
    ['reject'],
  ])('falls back to a generic message %#', async (response) => {
    if (response === 'reject') mockFetch.mockRejectedValueOnce('offline')
    else mockFetch.mockResolvedValueOnce(response)
    renderDrawer()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this booking.')
  })

  it('takes focus, traps Tab, closes on Escape or the backdrop, and returns focus', async () => {
    const onClose = jest.fn()
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const view = render(<BookingDrawer bookingId="b2" onClose={onClose} />)
    const close = screen.getByRole('button', { name: 'Close booking details' })
    expect(close).toHaveFocus()
    await screen.findByRole('region', { name: 'Actions' })

    const focusable = screen.getByRole('dialog').querySelectorAll<HTMLElement>('button, [href]')
    const last = focusable[focusable.length - 1]
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(close, { key: 'a' })

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('booking-drawer-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(2)

    view.unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('ignores a response that arrives after it closed', async () => {
    let resolve: (value: unknown) => void = () => undefined
    mockFetch.mockReturnValue(new Promise((done) => (resolve = done)))
    const { unmount } = render(<BookingDrawer bookingId="b2" onClose={jest.fn()} />)
    unmount()
    resolve(respond(DETAIL))
    await Promise.resolve()
  })
})

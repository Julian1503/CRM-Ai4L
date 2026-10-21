import { render, screen } from '@testing-library/react'

const mockFindBookingByToken = jest.fn()
const mockApplyPayment = jest.fn()
const mockProcessNotifications = jest.fn()
const mockIsSupabaseConfigured = jest.fn()
const mockGetStripeConfig = jest.fn()
const mockRetrieve = jest.fn()

jest.mock('@/lib/booking/repository', () => ({
  findBookingByToken: (...args: unknown[]) => mockFindBookingByToken(...args),
}))
jest.mock('@/lib/booking/payment', () => ({
  ...jest.requireActual('@/lib/booking/payment'),
  applyCheckoutPayment: (...args: unknown[]) => mockApplyPayment(...args),
}))
jest.mock('@/lib/booking/notifications', () => ({
  processNotifications: (...args: unknown[]) => mockProcessNotifications(...args),
}))
jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({}) }))
const mockHeaders = jest.fn()
jest.mock('next/headers', () => ({ headers: () => mockHeaders() }))
jest.mock('@/lib/supabase/config', () => ({
  isSupabaseConfigured: () => mockIsSupabaseConfigured(),
}))
jest.mock('@/lib/stripe/client', () => ({
  getStripeConfig: () => mockGetStripeConfig(),
  getStripeClient: () => ({ checkout: { sessions: { retrieve: mockRetrieve } } }),
}))

import ScheduledPage from './page'

const ORIGINAL_ENV = process.env
const booking = {
  id: 'b1',
  status: 'checkout_started',
  stripe_session_id: 'cs_1',
  contact: {
    email: 'ada@example.com',
    first_name: 'Ada',
    last_name: 'Lovelace',
  },
}

async function renderPage(session: string | undefined) {
  const ui = await ScheduledPage({
    params: Promise.resolve({ token: 'tok-1' }),
    searchParams: Promise.resolve(session ? { session } : {}),
  })
  return render(ui)
}

describe('ScheduledPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = {
      ...ORIGINAL_ENV,
      NEXT_PUBLIC_CALENDLY_SCHEDULING_URL: 'https://calendly.com/ai4l/consultation',
    }
    mockIsSupabaseConfigured.mockReturnValue(true)
    mockFindBookingByToken.mockResolvedValue(booking)
    mockApplyPayment.mockResolvedValue('applied')
    mockProcessNotifications.mockResolvedValue({ claimed: 1, sent: 1, skipped: 0, retried: 0 })
    mockGetStripeConfig.mockReturnValue({ secretKey: 'sk_test' })
    mockRetrieve.mockResolvedValue({
      id: 'cs_1',
      status: 'complete',
      payment_status: 'no_payment_required',
      amount_total: 0,
      metadata: { booking_id: 'b1' },
    })
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('shows Calendly only after Stripe confirms the exact $0 session', async () => {
    await renderPage('cs_1')

    expect(screen.getByText(/Confirmed/)).toBeInTheDocument()
    const frame = screen.getByTitle('Choose a consultation time')
    expect(frame).toHaveAttribute('src', expect.stringContaining('utm_content=b1'))
    // The same operation the webhook uses (audit H10).
    expect(mockApplyPayment).toHaveBeenCalledWith(expect.anything(), {
      bookingId: 'b1',
      session: expect.objectContaining({ id: 'cs_1' }),
    })
    expect(mockProcessNotifications).toHaveBeenCalled()
  })

  it('confirms when the webhook got there first', async () => {
    mockApplyPayment.mockResolvedValue('already_applied')

    await renderPage('cs_1')

    expect(screen.getByTitle('Choose a consultation time')).toBeInTheDocument()
    expect(mockProcessNotifications).not.toHaveBeenCalled()
  })

  it.each([
    ['booked', /already booked/],
    ['cancelled', /was cancelled/],
  ])('does not offer Calendly again for a %s consultation', async (status, heading) => {
    mockFindBookingByToken.mockResolvedValue({ ...booking, status })
    mockApplyPayment.mockResolvedValue('already_applied')

    await renderPage('cs_1')

    expect(screen.queryByTitle('Choose a consultation time')).toBeNull()
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
  })

  it('does not confirm a checkout the database refuses', async () => {
    mockApplyPayment.mockResolvedValue('mismatch')

    await renderPage('cs_1')

    expect(screen.queryByTitle('Choose a consultation time')).toBeNull()
  })

  it('does not expose Calendly when the session query is missing', async () => {
    await renderPage(undefined)

    expect(screen.queryByTitle('Choose a consultation time')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/could not confirm/i)
    expect(mockRetrieve).not.toHaveBeenCalled()
  })

  it('does not expose Calendly for another session id', async () => {
    await renderPage('cs_other')

    expect(screen.queryByTitle('Choose a consultation time')).toBeNull()
    expect(mockRetrieve).not.toHaveBeenCalled()
  })

  it('does not expose Calendly for a non-zero or incomplete checkout', async () => {
    mockRetrieve.mockResolvedValue({
      id: 'cs_1',
      status: 'open',
      payment_status: 'unpaid',
      amount_total: 50_000,
      metadata: { booking_id: 'b1' },
    })

    await renderPage('cs_1')

    expect(screen.queryByTitle('Choose a consultation time')).toBeNull()
    expect(mockApplyPayment).not.toHaveBeenCalled()
  })

  describe('Calendly confirmation (P4.5)', () => {
    afterEach(() => mockHeaders.mockReset())

    it('names this site in the embed so Calendly can report the booking to the page', async () => {
      mockHeaders.mockResolvedValue(new Headers({ host: 'crm.ai4l.example' }))
      await renderPage('cs_1')

      const src = new URL(screen.getByTitle('Choose a consultation time').getAttribute('src')!)
      expect(src.searchParams.get('embed_domain')).toBe('crm.ai4l.example')
      expect(src.searchParams.get('embed_type')).toBe('Inline')
    })

    it('still embeds Calendly when the host is unknown', async () => {
      mockHeaders.mockImplementation(() => {
        throw new Error('outside a request')
      })
      await renderPage('cs_1')

      const src = new URL(screen.getByTitle('Choose a consultation time').getAttribute('src')!)
      expect(src.searchParams.get('embed_domain')).toBeNull()
      expect(src.searchParams.get('utm_content')).toBe('b1')
    })

    it('leaves the host out when the request has none', async () => {
      mockHeaders.mockResolvedValue(new Headers())
      await renderPage('cs_1')
      expect(screen.getByTitle('Choose a consultation time').getAttribute('src')).not.toContain('embed_domain')
    })
  })
})

import { render, screen } from '@testing-library/react'

const mockLoadBookingForDisplay = jest.fn()
const mockIsSupabaseConfigured = jest.fn()

jest.mock('@/lib/booking/repository', () => ({
  loadBookingForDisplay: (...args: unknown[]) => mockLoadBookingForDisplay(...args),
}))
jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({}) }))
jest.mock('@/lib/supabase/config', () => ({
  isSupabaseConfigured: () => mockIsSupabaseConfigured(),
}))
jest.mock('./BookingStarter', () => ({
  __esModule: true,
  default: () => <button data-testid="start-booking">Claim my free consultation</button>,
}))

import BookingPage from './page'

/** Async Server Components resolve to an element, which RTL can then render. */
async function renderPage(token = 'tok-1') {
  const ui = await BookingPage({ params: Promise.resolve({ token }) })
  return render(ui)
}

describe('BookingPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsSupabaseConfigured.mockReturnValue(true)
  })

  describe('valid link', () => {
    beforeEach(() => {
      mockLoadBookingForDisplay.mockResolvedValue({
        booking: { contact: { first_name: 'Ada' } },
        usable: true,
        reason: null,
      })
    })

    it('greets the contact by name', async () => {
      await renderPage()

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Ada')
    })

    it('shows the $500 value struck through against $0', async () => {
      // The whole proposition is "worth $500, costs nothing".
      await renderPage()

      expect(screen.getByText('$500')).toBeInTheDocument()
      expect(screen.getByText('$0')).toBeInTheDocument()
    })

    it('promises no payment details will be requested', async () => {
      await renderPage()

      expect(screen.getByText(/not be asked for payment details/i)).toBeInTheDocument()
    })

    it('offers the booking action', async () => {
      await renderPage()

      expect(screen.getByTestId('start-booking')).toBeInTheDocument()
    })
  })

  describe('invalid link', () => {
    it('does not offer the booking action', async () => {
      mockLoadBookingForDisplay.mockResolvedValue({
        booking: null,
        usable: false,
        reason: 'not_found',
      })

      await renderPage()

      expect(screen.queryByTestId('start-booking')).not.toBeInTheDocument()
    })

    it.each(['not_found', 'expired'])(
      'gives the same heading for reason "%s", so tokens cannot be probed',
      async (reason) => {
        mockLoadBookingForDisplay.mockResolvedValue({ booking: null, usable: false, reason })

        await renderPage()

        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
          'This link is no longer valid'
        )
      }
    )

    it('explains an already-used link differently, since that is not a probe risk', async () => {
      // The visitor legitimately owns this link; telling them it was used is helpful
      // and reveals nothing an attacker could not already infer.
      mockLoadBookingForDisplay.mockResolvedValue({
        booking: null,
        usable: false,
        reason: 'already_used',
      })

      await renderPage()

      expect(screen.getByText(/already been used/i)).toBeInTheDocument()
    })
  })

  it('degrades to the invalid message when Supabase is unconfigured', async () => {
    mockIsSupabaseConfigured.mockReturnValue(false)

    await renderPage()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('no longer valid')
    expect(mockLoadBookingForDisplay).not.toHaveBeenCalled()
  })

  it('does not crash the page when the lookup throws', async () => {
    mockLoadBookingForDisplay.mockRejectedValue(new Error('db down'))

    await renderPage()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('no longer valid')
  })
})

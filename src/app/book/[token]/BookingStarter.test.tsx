import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import BookingStarter from './BookingStarter'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

const mockNavigate = jest.fn()

// window.location is non-configurable in current jsdom, so navigation is mocked at
// the module seam instead of by replacing the global.
jest.mock('@/lib/browser/navigate', () => ({
  navigateTo: (url: string) => mockNavigate(url),
}))

describe('BookingStarter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('posts the token to start a checkout', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://checkout.stripe.com/x' }),
    })

    render(<BookingStarter token="tok-1" />)
    fireEvent.click(screen.getByTestId('start-booking'))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/booking/create-session',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'tok-1' }) })
      )
    )
  })

  it('redirects to Stripe on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://checkout.stripe.com/x' }),
    })

    render(<BookingStarter token="tok-1" />)
    fireEvent.click(screen.getByTestId('start-booking'))

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('https://checkout.stripe.com/x'))
  })

  it('stays disabled after a successful start', async () => {
    // The page is navigating away; re-enabling would invite a second click mid-redirect.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://checkout.stripe.com/x' }),
    })

    render(<BookingStarter token="tok-1" />)
    fireEvent.click(screen.getByTestId('start-booking'))

    await waitFor(() => expect(screen.getByTestId('start-booking')).toBeDisabled())
  })

  it('shows the server message when the link is rejected', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'This booking link is no longer valid.' }),
    })

    render(<BookingStarter token="tok-1" />)
    fireEvent.click(screen.getByTestId('start-booking'))

    expect(await screen.findByRole('alert')).toHaveTextContent('no longer valid')
  })

  it('re-enables the button after a failure so the visitor can retry', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Try again.' }) })

    render(<BookingStarter token="tok-1" />)
    fireEvent.click(screen.getByTestId('start-booking'))

    await waitFor(() => expect(screen.getByTestId('start-booking')).toBeEnabled())
  })

  it('handles a network failure without leaving a dead button', async () => {
    mockFetch.mockRejectedValue(new Error('offline'))

    render(<BookingStarter token="tok-1" />)
    fireEvent.click(screen.getByTestId('start-booking'))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('start-booking')).toBeEnabled()
  })

  it('treats a success response with no url as a failure', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) })

    render(<BookingStarter token="tok-1" />)
    fireEvent.click(screen.getByTestId('start-booking'))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

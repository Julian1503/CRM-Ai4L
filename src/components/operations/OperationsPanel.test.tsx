import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import OperationsPanel from './OperationsPanel'

const SUMMARY = {
  generatedAt: '2026-08-25T01:00:00.000Z',
  integrations: [
    {
      provider: 'emailoctopus',
      deliveries24h: 3,
      failed24h: 0,
      processing: 0,
      processingStale: 0,
      events24h: 20,
      failedEvents24h: 0,
      lastDeliveryAt: '2026-08-25T00:55:00.000Z',
      lastSuccessAt: '2026-08-25T00:55:01.000Z',
      lastFailureAt: null,
    },
    {
      provider: 'stripe',
      deliveries24h: 2,
      failed24h: 1,
      processing: 0,
      processingStale: 0,
      events24h: 2,
      failedEvents24h: 1,
      lastDeliveryAt: '2026-08-25T00:40:00.000Z',
      lastSuccessAt: null,
      lastFailureAt: '2026-08-25T00:40:01.000Z',
    },
    {
      provider: 'calendly',
      deliveries24h: 0,
      failed24h: 0,
      processing: 0,
      processingStale: 0,
      events24h: 0,
      failedEvents24h: 0,
      lastDeliveryAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    },
  ],
  campaignSends: { pending: 1, sent: 14, failed: 2, skipped: 0 },
  bookings: {
    pending: 1,
    checkoutStarted: 1,
    paid: 2,
    booked: 7,
    cancelled: 1,
    expired: 0,
  },
  sync: { events24h: 4, failures24h: 0, latestAt: '2026-08-25T00:50:00.000Z' },
} as const

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) }) as Promise<Response>
}

describe('OperationsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn(() => jsonResponse({ summary: SUMMARY }))
  })

  it('shows provider health and the conversion queues', async () => {
    render(<OperationsPanel />)

    expect(await screen.findByText('EmailOctopus')).toBeInTheDocument()
    expect(screen.getByText('Healthy')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText('No deliveries')).toBeInTheDocument()
    expect(screen.getByText('14 sent')).toBeInTheDocument()
    expect(screen.getByText('7 booked')).toBeInTheDocument()
  })

  it('fetches an uncached aggregate', async () => {
    render(<OperationsPanel />)

    await screen.findByText('EmailOctopus')
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/operations/summary',
      expect.objectContaining({ cache: 'no-store' })
    )
  })

  it('lets the operator retry a failed read', async () => {
    const fetchMock = jest
      .fn()
      .mockImplementationOnce(() => jsonResponse({ error: 'Unavailable' }, false))
      .mockImplementationOnce(() => jsonResponse({ summary: SUMMARY }))
    global.fetch = fetchMock

    render(<OperationsPanel />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(screen.getByText('EmailOctopus')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

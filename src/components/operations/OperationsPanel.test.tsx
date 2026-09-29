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

const STRIPE_READY = {
  ok: true,
  configured: true,
  mode: 'test',
  price: { id: 'price_1', amount: 50_000, currency: 'aud', active: true },
  coupon: { id: 'coupon_1', percentOff: 100, valid: true },
  problems: [],
}

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) }) as Promise<Response>
}

/**
 * Routes by URL rather than by call order: the panel reads the summary and the Stripe
 * check independently, and a queue of responses would silently pair the wrong body with
 * the wrong request the moment either one is retried.
 */
function routeFetch(
  handlers: { summary?: () => Promise<Response>; stripe?: () => Promise<Response> } = {}
) {
  const mock = jest.fn((url: string) =>
    String(url).includes('/stripe')
      ? (handlers.stripe ?? (() => jsonResponse(STRIPE_READY)))()
      : (handlers.summary ?? (() => jsonResponse({ summary: SUMMARY })))()
  )

  global.fetch = mock as unknown as typeof fetch

  return mock
}

describe('OperationsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    routeFetch()
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

  describe('stuck work', () => {
    it('lists each kind of stuck work with what to do about it', async () => {
      routeFetch({
        summary: () =>
          jsonResponse({
            summary: {
              ...SUMMARY,
              attention: { uncertainSends: 2, expiredSendClaims: 1, consentSyncPending: 4, consentSyncFailed: 3 },
            },
          }),
      })
      render(<OperationsPanel />)

      const list = await screen.findByTestId('attention-list')
      expect(list).toHaveTextContent(/2 campaign recipient\(s\) have an unknown delivery outcome/)
      expect(list).toHaveTextContent(/1 recipient claim\(s\) expired/)
      expect(list).toHaveTextContent(/3 consent change\(s\) could not reach EmailOctopus/)
      expect(list).toHaveTextContent(/4 consent change\(s\) are waiting/)
    })

    it('says plainly when nothing is waiting', async () => {
      routeFetch({
        summary: () =>
          jsonResponse({
            summary: {
              ...SUMMARY,
              attention: { uncertainSends: 0, expiredSendClaims: 0, consentSyncPending: 0, consentSyncFailed: 0 },
            },
          }),
      })
      render(<OperationsPanel />)

      expect(await screen.findByTestId('attention-clear')).toBeInTheDocument()
    })
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
    let attempts = 0
    const fetchMock = routeFetch({
      summary: () => {
        attempts += 1
        return attempts === 1
          ? jsonResponse({ error: 'Unavailable' }, false)
          : jsonResponse({ summary: SUMMARY })
      },
    })

    render(<OperationsPanel />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(screen.getByText('EmailOctopus')).toBeInTheDocument())
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('summary'))).toHaveLength(2)
  })

  describe('Stripe readiness', () => {
    it('says booking links cannot start a checkout, and why', async () => {
      // A price id from the wrong Stripe mode produces no failed deliveries at all —
      // every booking link just dies at the button, on the lead's screen, silently.
      routeFetch({
        stripe: () =>
          jsonResponse({
            ok: false,
            configured: true,
            mode: 'live',
            price: null,
            coupon: null,
            problems: ['STRIPE_CONSULTATION_PRICE_ID (price_1) could not be read: No such price.'],
          }),
      })

      render(<OperationsPanel />)

      const card = await screen.findByTestId('stripe-health')
      expect(card).toHaveTextContent('Booking links cannot start a checkout.')
      expect(card).toHaveTextContent('No such price.')
      expect(card).toHaveTextContent('Stripe key mode: live')
    })

    it('confirms a healthy configuration without shouting about it', async () => {
      render(<OperationsPanel />)

      expect(await screen.findByTestId('stripe-health')).toHaveTextContent(
        'Stripe ready in test mode · consultation $500 AUD discounted 100%'
      )
    })

    it('stays quiet when the check itself cannot be read', async () => {
      // Claiming a problem it did not observe would send someone chasing Stripe over a
      // network blip.
      routeFetch({ stripe: () => Promise.reject(new Error('offline')) })

      render(<OperationsPanel />)

      await screen.findByText('EmailOctopus')
      expect(screen.queryByTestId('stripe-health')).not.toBeInTheDocument()
    })
  })
})

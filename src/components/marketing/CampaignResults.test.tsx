import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { CampaignResult } from '@/lib/marketing/campaignResults'

import CampaignResults from './CampaignResults'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function result(overrides: Partial<CampaignResult> = {}): CampaignResult {
  return {
    id: 'c1',
    name: 'Summer courses',
    status: 'sent',
    consentStream: 'newsletter',
    segmentName: 'NSW leads',
    startedAt: '2026-10-28T22:00:00Z',
    completedAt: '2026-10-28T22:05:00Z',
    run: 1,
    send: {
      run: 1,
      total: 200,
      sent: 200,
      failed: 0,
      pending: 0,
      processing: 0,
      skipped: 0,
      uncertain: 0,
      failureReason: null,
      stallReason: null,
    },
    funnel: { started: 24, paid: 9, booked: 7, cancelled: 1, chargedCents: 0, lastBookingAt: null },
    ...overrides,
  }
}

beforeEach(() => jest.clearAllMocks())

describe('CampaignResults', () => {
  it('shows each sent campaign with who was emailed and how far they got', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [result()], total: 1 }))

    render(<CampaignResults onOpenCampaign={jest.fn()} />)

    const row = await screen.findByTestId('result-c1')
    expect(within(row).getByText('Summer courses')).toBeInTheDocument()
    expect(within(row).getByText('Sent')).toBeInTheDocument()
    expect(within(row).getByTestId('result-emailed-c1')).toHaveTextContent('200')
    // Each step is a share of the people emailed.
    expect(within(row).getByText('24')).toBeInTheDocument()
    expect(within(row).getByText('12%')).toBeInTheDocument()
    expect(within(row).getByText('9')).toBeInTheDocument()
    expect(within(row).getByText('7')).toBeInTheDocument()
    expect(within(row).getByText('4%')).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledWith('/api/campaigns/results?page=1&pageSize=25')
  })

  it('names what is still pending, failed or skipped instead of folding it into the count', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        results: [
          result({
            status: 'failed',
            send: { ...result().send!, sent: 150, failed: 30, pending: 10, skipped: 5, uncertain: 5 },
          }),
        ],
        total: 1,
      })
    )

    render(<CampaignResults onOpenCampaign={jest.fn()} />)

    const row = await screen.findByTestId('result-c1')
    expect(within(row).getByText('10 still to go · 30 failed · 5 to check · 5 skipped')).toBeInTheDocument()
    expect(within(row).getByText('Failed')).toBeInTheDocument()
  })

  it('shows what was charged only when something was', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ results: [result({ funnel: { ...result().funnel, chargedCents: 125050 } })], total: 1 })
    )

    render(<CampaignResults onOpenCampaign={jest.fn()} />)

    expect(await screen.findByText('$1,250.50')).toBeInTheDocument()
  })

  it('opens the campaign from its row', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [result()], total: 1 }))
    const onOpenCampaign = jest.fn()

    render(<CampaignResults onOpenCampaign={onOpenCampaign} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Summer courses' }))

    expect(onOpenCampaign).toHaveBeenCalledWith('c1')
  })

  it('says so when nothing has been sent yet', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [], total: 0 }))

    render(<CampaignResults onOpenCampaign={jest.fn()} />)

    expect(await screen.findByTestId('campaign-results-empty')).toHaveTextContent(/No campaign has been sent yet/)
  })

  it('shows a failed load as a failure with a retry, never as an empty list', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'Could not load campaign results.' }, false, 500))
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [result()], total: 1 }))

    render(<CampaignResults onOpenCampaign={jest.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load campaign results.')
    expect(screen.queryByTestId('campaign-results-empty')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByTestId('result-c1')).toBeInTheDocument())
  })
})

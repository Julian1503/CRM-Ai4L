import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import SendConfirmDialog from './SendConfirmDialog'
import TestSendPanel from './TestSendPanel'

const URL = '/api/campaigns/camp-1/test-send'

const TESTED = { id: 'ts-1', revision: 3, recipient: 'qa@ai4l.com.au', outcome: 'sent', error: null, created_at: '2026-10-08T01:00:00Z' }

function state(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    recipients: ['qa@ai4l.com.au', 'owner@ai4l.com.au'],
    revision: 3,
    testSends: [],
    status: { lastSuccessful: null, currentRevisionTested: false },
    ...overrides,
  }
}

function respond(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function mockFetch(getBodies: unknown[], post: unknown = respond({ testSend: TESTED, note: null })) {
  const queue = [...getBodies]
  const fetchMock = jest.fn(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return post
    return respond(queue.length > 1 ? queue.shift() : queue[0])
  })
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('TestSendPanel', () => {
  it('sends the version on screen to a recipient picked from the allowlist', async () => {
    const fetchMock = mockFetch([state(), state({ testSends: [TESTED], status: { lastSuccessful: TESTED, currentRevisionTested: true } })])
    render(<TestSendPanel campaignId="camp-1" revision={3} />)

    fireEvent.change(await screen.findByTestId('test-recipient'), { target: { value: 'owner@ai4l.com.au' } })
    fireEvent.click(screen.getByTestId('send-test'))

    await waitFor(() => expect(screen.getByTestId('test-status')).toHaveTextContent('This version has been tested.'))
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(postCall?.[0]).toBe(URL)
    expect(JSON.parse(String((postCall?.[1] as { body: string }).body))).toEqual({ recipient: 'owner@ai4l.com.au', revision: 3 })
    expect(screen.getByTestId('test-status')).toHaveTextContent('qa@ai4l.com.au')
  })

  it('warns when the content changed since the last test', async () => {
    mockFetch([state({ revision: 4, status: { lastSuccessful: TESTED, currentRevisionTested: false } })])
    render(<TestSendPanel campaignId="camp-1" revision={4} />)

    expect(await screen.findByTestId('test-stale')).toHaveTextContent('The content changed since the last test')
  })

  it('explains when test sends are not set up', async () => {
    mockFetch([state({ enabled: false, recipients: [] })])
    render(<TestSendPanel campaignId="camp-1" revision={3} />)

    expect(await screen.findByText(/CAMPAIGN_TEST_RECIPIENTS/)).toBeInTheDocument()
    expect(screen.queryByTestId('send-test')).not.toBeInTheDocument()
  })

  it('shows a failed test and a refused request', async () => {
    const failed = { ...TESTED, outcome: 'failed', error: 'Contact unsubscribed' }
    mockFetch([state(), state({ testSends: [failed] })], respond({ testSend: failed, note: null }))
    render(<TestSendPanel campaignId="camp-1" revision={3} />)

    fireEvent.click(await screen.findByTestId('send-test'))
    expect(await screen.findByRole('alert')).toHaveTextContent('The test was not sent: Contact unsubscribed')
    expect(await screen.findByTestId('test-latest-problem')).toHaveTextContent('Failed — Contact unsubscribed')
  })

  it('shows the rate limit message', async () => {
    mockFetch([state()], respond({ error: 'At most 5 test sends per campaign per hour.' }, false, 429))
    render(<TestSendPanel campaignId="camp-1" revision={3} />)

    fireEvent.click(await screen.findByTestId('send-test'))
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 5 test sends')
  })

  it('reports a history that cannot be loaded', async () => {
    global.fetch = jest.fn(async () => respond({ error: 'Could not load test sends.' }, false, 500)) as unknown as typeof fetch
    render(<TestSendPanel campaignId="camp-1" revision={3} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load test sends.')
  })
})

describe('SendConfirmDialog test status', () => {
  const props = { campaignName: 'x', audienceLabel: 'All', audienceSize: 10, loading: false, error: null, onConfirm: jest.fn(), onClose: jest.fn() }

  it('says whether this version was tested, without blocking the send', () => {
    const { rerender } = render(<SendConfirmDialog {...props} tested={false} />)
    expect(screen.getByTestId('send-confirm-tested')).toHaveTextContent('has not been tested')
    expect(screen.getByTestId('confirm-send')).toBeEnabled()

    rerender(<SendConfirmDialog {...props} tested />)
    expect(screen.getByTestId('send-confirm-tested')).toHaveTextContent('This version was tested')

    rerender(<SendConfirmDialog {...props} />)
    expect(screen.queryByTestId('send-confirm-tested')).not.toBeInTheDocument()
  })
})

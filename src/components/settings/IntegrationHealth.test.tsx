import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import IntegrationHealth from './IntegrationHealth'

const CHECKS = [
  { id: 'database', label: 'Database', state: 'ok', summary: 'Reachable, and your membership is active.', checkedAt: '2026-10-12T00:00:00Z', details: ['Answered in 40 ms.'] },
  {
    id: 'stripe',
    label: 'Stripe',
    state: 'down',
    summary: 'Booking checkout cannot start with this Stripe configuration.',
    checkedAt: '2026-10-12T00:00:00Z',
    actionHint: 'Fix the items listed in Stripe, then test again.',
  },
  { id: 'signup', label: 'Sign-up policy', state: 'degraded', summary: 'Public sign-up is open.', checkedAt: '2026-10-12T00:00:00Z' },
  { id: 'cron', label: 'Scheduled jobs', state: 'not_configured', summary: 'Runs are not recorded.', checkedAt: '2026-10-12T00:00:00Z' },
]

function respond(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function mockFetch(test: unknown = respond({ check: { ...CHECKS[1], state: 'ok', summary: 'Live mode: ready.' } })) {
  const fetchMock = jest.fn(async (url: string, init?: { method?: string }) => (init?.method === 'POST' ? test : respond({ checks: CHECKS })))
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('IntegrationHealth', () => {
  it('shows each check with its state, summary, details and next step', async () => {
    mockFetch()
    render(<IntegrationHealth />)

    expect(await screen.findByTestId('health-state-database')).toHaveTextContent('Working')
    expect(screen.getByTestId('health-state-stripe')).toHaveTextContent('Not working')
    expect(screen.getByTestId('health-state-signup')).toHaveTextContent('Needs attention')
    expect(screen.getByTestId('health-state-cron')).toHaveTextContent('Not set up')
    expect(screen.getByText('Answered in 40 ms.')).toBeInTheDocument()
    expect(within(screen.getByTestId('health-stripe')).getByText(/Fix the items listed in Stripe/)).toBeInTheDocument()
    expect(screen.getAllByText(/^Checked /)).toHaveLength(4)
  })

  it('shows only the requested checks, in order', async () => {
    mockFetch()
    render(<IntegrationHealth only={['cron', 'database']} title="Platform" />)

    await screen.findByTestId('health-database')
    expect(screen.getByRole('heading', { name: 'Platform' })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)).toEqual(['Scheduled jobs', 'Database'])
  })

  it('re-runs one check and replaces its card', async () => {
    const fetchMock = mockFetch()
    render(<IntegrationHealth />)

    fireEvent.click(await screen.findByRole('button', { name: 'Test connection: Stripe' }))

    await waitFor(() => expect(screen.getByTestId('health-state-stripe')).toHaveTextContent('Working'))
    expect(fetchMock).toHaveBeenCalledWith('/api/integrations/health/stripe/test', { method: 'POST' })
  })

  it('says when a member may not run the test', async () => {
    mockFetch(respond({ error: 'Only an administrator can test a connection.' }, false, 403))
    render(<IntegrationHealth />)

    fireEvent.click(await screen.findByRole('button', { name: 'Test connection: Database' }))

    expect(await within(screen.getByTestId('health-database')).findByRole('alert')).toHaveTextContent('Only an administrator')
  })

  it('reports a list that cannot be loaded, and checks again on request', async () => {
    const fetchMock = jest.fn(async () => respond({ error: 'Could not check the integrations.' }, false, 500))
    global.fetch = fetchMock as unknown as typeof fetch
    render(<IntegrationHealth />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check the integrations.')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('ignores malformed entries', async () => {
    global.fetch = jest.fn(async () => respond({ checks: [{ nope: true }, CHECKS[0]] })) as unknown as typeof fetch
    render(<IntegrationHealth />)

    expect(await screen.findByTestId('health-database')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').filter((item) => item.dataset.testid?.startsWith('health-'))).toHaveLength(1)
  })
})

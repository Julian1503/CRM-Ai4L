import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import PublicationHistory, { PUBLICATION_POLL_MS } from './PublicationHistory'
import { bodyOf, errorResponse, jsonResponse, makeAccount, makePublication, routeFetch } from './testUtils'

const PUBLICATIONS = '/api/social/publications'
const ACCOUNTS = '/api/social/accounts'
const RESOLVE = '/api/content-studio/jobs/job-pub-2/resolve'

const accounts = jsonResponse({
  accounts: [makeAccount(), makeAccount({ id: 'acct-2', platform: 'linkedin', displayName: 'AI4L Company' })],
  enabledPlatforms: ['facebook', 'linkedin'],
})

const uncertain = makePublication({ id: 'pub-2', accountId: 'acct-2', jobId: 'job-pub-2', status: 'uncertain', permalink: null, errorMessage: 'Timed out' })

describe('PublicationHistory', () => {
  it('lists publications with account, status, errors and links, filtered by account', async () => {
    const mock = routeFetch({
      [`GET ${PUBLICATIONS}`]: jsonResponse({ publications: [makePublication({ resolutionNote: 'Checked by Ana' }), uncertain] }),
      [`GET ${ACCOUNTS}`]: accounts,
    })
    render(<PublicationHistory itemId="item-1" />)

    expect(await screen.findByText('AI4L Page · Facebook')).toBeInTheDocument()
    expect(mock.mock.calls[0][0]).toBe(`${PUBLICATIONS}?itemId=item-1`)
    expect(screen.getByText('Published')).toBeInTheDocument()
    expect(screen.getByText('Resolution: Checked by Ana')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View the post ↗' })).toHaveAttribute('href', 'https://facebook.com/post/1')
    expect(await screen.findByText('AI4L Company · LinkedIn')).toBeInTheDocument()
    expect(screen.getByText('Timed out')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acct-2' } })
    expect(screen.queryByText('AI4L Page · Facebook')).not.toBeInTheDocument()
  })

  it('records the outcome of an uncertain publication', async () => {
    const mock = routeFetch({
      [`GET ${PUBLICATIONS}`]: jsonResponse({ publications: [uncertain] }),
      [`GET ${ACCOUNTS}`]: accounts,
      [`POST ${RESOLVE}`]: jsonResponse({ job: {} }),
    })
    render(<PublicationHistory />)

    fireEvent.click(await screen.findByRole('button', { name: 'Record the outcome' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Say what you checked.')

    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Found it live' } })
    fireEvent.change(screen.getByLabelText('Post link (optional)'), { target: { value: 'http://bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }))
    expect(screen.getByRole('alert')).toHaveTextContent('https://')

    fireEvent.change(screen.getByLabelText('Post ID (optional)'), { target: { value: 'li-1' } })
    fireEvent.change(screen.getByLabelText('Post link (optional)'), { target: { value: 'https://linkedin.com/p/1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }))

    await waitFor(() =>
      expect(bodyOf(mock, 'POST', RESOLVE)).toEqual({ resolution: 'succeeded', note: 'Found it live', externalId: 'li-1', permalink: 'https://linkedin.com/p/1' })
    )
    await waitFor(() => expect(mock.mock.calls.filter(([url]) => url === PUBLICATIONS)).toHaveLength(2))
  })

  it('records a failure without post details and reports errors', async () => {
    const mock = routeFetch({
      [`GET ${PUBLICATIONS}`]: jsonResponse({ publications: [uncertain] }),
      [`GET ${ACCOUNTS}`]: errorResponse(500, 'x'),
      [`POST ${RESOLVE}`]: errorResponse(409, 'Already resolved'),
    })
    render(<PublicationHistory embedded />)

    expect(await screen.findByText('Unknown account')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Record the outcome' }))
    fireEvent.click(screen.getByLabelText('It was not published'))
    expect(screen.queryByLabelText('Post ID (optional)')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Not on the page' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }))

    expect(await screen.findByText('Already resolved')).toBeInTheDocument()
    expect(bodyOf(mock, 'POST', RESOLVE)).toEqual({ resolution: 'failed', note: 'Not on the page' })

    fireEvent.click(screen.getByLabelText('It was published'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Record the outcome' })).toBeInTheDocument()
  })

  it('handles an uncertain publication without a job', async () => {
    routeFetch({ [`GET ${PUBLICATIONS}`]: jsonResponse({ publications: [{ ...uncertain, jobId: null }] }), [`GET ${ACCOUNTS}`]: accounts })
    render(<PublicationHistory />)
    expect(await screen.findByText(/no job to resolve/)).toBeInTheDocument()
  })

  it('shows empty, unavailable and error states', async () => {
    routeFetch({ [`GET ${PUBLICATIONS}`]: jsonResponse({ publications: [] }), [`GET ${ACCOUNTS}`]: accounts })
    const first = render(<PublicationHistory />)
    expect(await screen.findByText('Nothing has been published yet.')).toBeInTheDocument()
    first.unmount()

    routeFetch({})
    const second = render(<PublicationHistory />)
    expect(await screen.findByText('Social publishing is not available in this CRM yet.')).toBeInTheDocument()
    second.unmount()

    const responses = [errorResponse(500, 'History broke'), jsonResponse({ publications: [] })]
    routeFetch({ [`GET ${PUBLICATIONS}`]: () => responses.shift() ?? jsonResponse({}), [`GET ${ACCOUNTS}`]: accounts })
    render(<PublicationHistory />)
    expect(await screen.findByText(/History broke/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Nothing has been published yet.')).toBeInTheDocument()
  })

  it('re-reads while a publication is still queued or being sent, then stops', async () => {
    jest.useFakeTimers()
    try {
      const responses = [
        jsonResponse({ publications: [makePublication({ status: 'dispatching', permalink: null })] }),
        jsonResponse({ publications: [makePublication()] }),
      ]
      const mock = routeFetch({
        [`GET ${PUBLICATIONS}`]: () => responses.shift() ?? jsonResponse({ publications: [makePublication()] }),
        [`GET ${ACCOUNTS}`]: accounts,
      })
      render(<PublicationHistory />)

      expect(await screen.findByText('Publishing')).toBeInTheDocument()
      await act(async () => {
        jest.advanceTimersByTime(PUBLICATION_POLL_MS)
      })
      expect(await screen.findByText('Published')).toBeInTheDocument()
      await act(async () => {
        jest.advanceTimersByTime(PUBLICATION_POLL_MS * 3)
      })
      expect(mock.mock.calls.filter(([url]) => url === PUBLICATIONS)).toHaveLength(2)
    } finally {
      jest.useRealTimers()
    }
  })
})

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import GenerationProgress from './GenerationProgress'
import { POLL_INITIAL_MS } from './hooks'
import { bodyOf, errorResponse, jsonResponse, makeJob, routeFetch } from './testUtils'

const JOB = '/api/content-studio/jobs/job-1'
const GENERATE = '/api/content-studio/items/item-1/generate'

function renderProgress(jobs = [makeJob()], onChanged = jest.fn()) {
  render(<GenerationProgress itemId="item-1" itemChannels={['facebook', 'email']} jobs={jobs} onChanged={onChanged} />)
  return onChanged
}

describe('GenerationProgress', () => {
  it('renders nothing when no job needs attention', () => {
    routeFetch({})
    const { container } = render(<GenerationProgress itemId="item-1" itemChannels={[]} jobs={[makeJob({ status: 'succeeded' })]} onChanged={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('polls a running job and reloads the item when it ends', async () => {
    jest.useFakeTimers()
    try {
      routeFetch({ [`GET ${JOB}`]: jsonResponse({ job: makeJob({ status: 'succeeded' }) }) })
      const onChanged = renderProgress()

      expect(screen.getByText(/You can leave this page/)).toBeInTheDocument()
      await act(async () => {
        jest.advanceTimersByTime(POLL_INITIAL_MS)
      })
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
      expect(screen.getByText('Done')).toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it('cancels a running job', async () => {
    const mock = routeFetch({ [`POST ${JOB}/cancel`]: jsonResponse({ job: makeJob({ cancelRequestedAt: 'now' }) }) })
    const onChanged = renderProgress()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(bodyOf(mock, 'POST', `${JOB}/cancel`)).toEqual({})
  })

  it('reports a failed cancel', async () => {
    routeFetch({ [`POST ${JOB}/cancel`]: errorResponse(409, 'Already finished') })
    renderProgress()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Already finished')
  })

  it('explains a pending cancellation instead of offering cancel again', () => {
    routeFetch({})
    renderProgress([makeJob({ cancelRequestedAt: '2026-09-30T10:00:00Z' })])
    expect(screen.getByText(/Cancelling/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('retries only the failed channels with a stable key', async () => {
    const responses = [errorResponse(503, 'Busy'), jsonResponse({ job: makeJob({ id: 'job-2' }) }, 202)]
    const mock = routeFetch({ [`POST ${GENERATE}`]: () => responses.shift() ?? jsonResponse({}) })
    const onChanged = renderProgress([
      makeJob({ status: 'succeeded', failures: [{ channel: 'email', errorCode: 'timeout', message: 'The model timed out' }] }),
    ])

    expect(screen.getByText('The model timed out')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed channels' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Busy')
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed channels' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())

    const bodies = mock.mock.calls.map(([, init]) => JSON.parse(String(init.body)))
    expect(bodies[0]).toMatchObject({ channels: ['email'] })
    expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey)
  })

  it('offers a full retry after an outright failure', () => {
    routeFetch({})
    renderProgress([makeJob({ status: 'failed', errorMessage: 'Provider error' })])
    expect(screen.getByText('Provider error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry generation' })).toBeInTheDocument()
  })

  it('tells the operator a person must check an uncertain job', () => {
    routeFetch({})
    const onChanged = renderProgress([makeJob({ status: 'uncertain', kind: 'generate_image' })])

    expect(screen.getByText(/A person must check/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reload item' }))
    expect(onChanged).toHaveBeenCalled()
  })

  it('hides retry after it is queued so a second click cannot queue a duplicate', async () => {
    const mock = routeFetch({ [`POST ${GENERATE}`]: jsonResponse({ job: makeJob({ id: 'job-2' }) }, 202) })
    const onChanged = renderProgress([makeJob({ status: 'failed' })])

    fireEvent.click(screen.getByRole('button', { name: 'Retry generation' }))

    expect(await screen.findByText('Retry queued.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    expect(onChanged).toHaveBeenCalled()
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('hides a failed job once newer work replaced it', () => {
    routeFetch({})
    renderProgress([
      makeJob({ id: 'old', status: 'failed', createdAt: '2026-01-01' }),
      makeJob({ id: 'new', status: 'running', createdAt: '2026-01-02' }),
    ])
    expect(screen.queryByTestId('generation-job-old')).not.toBeInTheDocument()
    expect(screen.getByTestId('generation-job-new')).toBeInTheDocument()
  })

  it('stops and explains when the job can no longer be read', async () => {
    jest.useFakeTimers()
    try {
      routeFetch({ [`GET ${JOB}`]: errorResponse(403, 'Forbidden') })
      renderProgress()
      await act(async () => {
        jest.advanceTimersByTime(POLL_INITIAL_MS)
      })
      expect(await screen.findByText(/no longer have access/)).toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it('labels image processing jobs', () => {
    routeFetch({})
    renderProgress([makeJob({ kind: 'ingest_asset', status: 'failed' })])
    expect(screen.getByText('Image processing')).toBeInTheDocument()
  })
})

import { act, renderHook, waitFor } from '@testing-library/react'

import { POLL_INITIAL_MS, POLL_MAX_MS, nextPollDelay, useIdempotencyKey, useJobPolling, useResource } from './hooks'
import { errorResponse, jsonResponse, makeJob, routeFetch } from './testUtils'

describe('useIdempotencyKey', () => {
  it('reuses the key for a retry of the same action until it settles', () => {
    const { result } = renderHook(() => useIdempotencyKey())

    const first = result.current.keyFor('save:a')
    expect(result.current.keyFor('save:a')).toBe(first)
    expect(result.current.keyFor('save:b')).not.toBe(first)

    const second = result.current.keyFor('save:b')
    result.current.settle()
    expect(result.current.keyFor('save:b')).not.toBe(second)
  })

  it('keeps a stable identity across renders', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey())
    const before = result.current
    rerender()
    expect(result.current).toBe(before)
  })
})

describe('useResource', () => {
  it('loads, reports errors while keeping data, and reloads', async () => {
    const load = jest.fn().mockResolvedValueOnce('one').mockRejectedValueOnce(new Error('broken')).mockResolvedValueOnce('three')
    const { result } = renderHook(() => useResource(load))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.data).toBe('one'))
    expect(result.current.loading).toBe(false)

    act(() => result.current.reload())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
    expect(result.current.data).toBe('one')

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.data).toBe('three'))
    expect(result.current.error).toBeNull()
  })

  it('ignores a result that arrives after unmount', async () => {
    let resolve: (value: string) => void = () => undefined
    const load = () => new Promise<string>((done) => (resolve = done))
    const { result, unmount } = renderHook(() => useResource(load))
    unmount()
    resolve('late')
    await Promise.resolve()
    expect(result.current.data).toBeNull()
  })

  it('ignores a rejection that arrives after unmount', async () => {
    let reject: (error: Error) => void = () => undefined
    const load = () => new Promise<string>((_, fail) => (reject = fail))
    const { result, unmount } = renderHook(() => useResource(load))
    unmount()
    reject(new Error('late'))
    await Promise.resolve()
    expect(result.current.error).toBeNull()
  })
})

describe('useResource source changes', () => {
  it('never shows one loader data as another loader data, even after the new one fails', async () => {
    const loadA = jest.fn().mockResolvedValue('A')
    const loadB = jest.fn().mockRejectedValue(new Error('B failed'))
    const { result, rerender } = renderHook(({ load }) => useResource(load), { initialProps: { load: loadA } })
    await waitFor(() => expect(result.current.data).toBe('A'))

    rerender({ load: loadB })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
    expect(result.current.data).toBeNull()
  })

  it('keeps the previous data while loading when asked, but not after a failure', async () => {
    const loadA = jest.fn().mockResolvedValue('A')
    let failB: (error: Error) => void = () => undefined
    const loadB = () => new Promise<string>((_, reject) => (failB = reject))
    const { result, rerender } = renderHook(({ load }) => useResource(load, { keepPrevious: true }), { initialProps: { load: loadA as () => Promise<string> } })
    await waitFor(() => expect(result.current.data).toBe('A'))

    rerender({ load: loadB })
    expect(result.current.data).toBe('A')
    expect(result.current.error).toBeNull()
    await act(async () => failB(new Error('B failed')))
    expect(result.current.data).toBeNull()
    expect(result.current.error).toBeInstanceOf(Error)
  })

  it('discards an earlier load that resolves after a reload', async () => {
    const resolvers: ((value: string) => void)[] = []
    const load = () => new Promise<string>((resolve) => resolvers.push(resolve))
    const { result } = renderHook(() => useResource(load))

    act(() => result.current.reload())
    await act(async () => resolvers[1]('newer'))
    expect(result.current.data).toBe('newer')
    await act(async () => resolvers[0]('older'))
    expect(result.current.data).toBe('newer')
    expect(result.current.loading).toBe(false)
  })
})

describe('useJobPolling', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('backs off between polls and settles once on a terminal status', async () => {
    const responses = [jsonResponse({ job: makeJob({ status: 'running' }) }), errorResponse(500, 'down'), jsonResponse({ job: makeJob({ status: 'succeeded' }) })]
    const mock = routeFetch({ 'GET /api/content-studio/jobs/job-1': () => responses.shift() ?? jsonResponse({}) })
    const onSettled = jest.fn()

    const { result } = renderHook(() => useJobPolling(makeJob({ status: 'queued' }), onSettled))

    await act(async () => {
      jest.advanceTimersByTime(POLL_INITIAL_MS)
    })
    expect(mock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.job.status).toBe('running'))

    await act(async () => {
      jest.advanceTimersByTime(nextPollDelay(POLL_INITIAL_MS))
    })
    await waitFor(() => expect(result.current.stale).toBe(true))

    await act(async () => {
      jest.advanceTimersByTime(POLL_MAX_MS)
    })
    await waitFor(() => expect(result.current.job.status).toBe('succeeded'))
    expect(result.current.stale).toBe(false)
    expect(onSettled).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(POLL_MAX_MS * 2)
    })
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it.each([
    [errorResponse(401, 'Signed out'), /no longer have access/],
    [errorResponse(403, 'Forbidden'), /no longer have access/],
    [errorResponse(404, 'Gone'), /no longer exists/],
    [errorResponse(503, 'Off', 'feature_disabled'), /switched off/],
  ])('stops polling for good on %#', async (response, reason) => {
    const mock = routeFetch({ 'GET /api/content-studio/jobs/job-1': response })
    const onSettled = jest.fn()
    const { result } = renderHook(() => useJobPolling(makeJob({ status: 'queued' }), onSettled))

    await act(async () => {
      jest.advanceTimersByTime(POLL_INITIAL_MS)
    })
    await waitFor(() => expect(result.current.stopped).toMatch(reason))
    await act(async () => {
      jest.advanceTimersByTime(POLL_MAX_MS * 3)
    })
    expect(mock).toHaveBeenCalledTimes(1)
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('does not poll a job that is already terminal', () => {
    const mock = routeFetch({})
    renderHook(() => useJobPolling(makeJob({ status: 'failed' })))
    jest.advanceTimersByTime(POLL_MAX_MS)
    expect(mock).not.toHaveBeenCalled()
  })

  it('prefers a terminal status learned by the parent', async () => {
    routeFetch({ 'GET /api/content-studio/jobs/job-1': jsonResponse({ job: makeJob({ status: 'running' }) }) })
    const { result, rerender } = renderHook(({ job }) => useJobPolling(job), { initialProps: { job: makeJob({ status: 'queued' }) } })

    await act(async () => {
      jest.advanceTimersByTime(POLL_INITIAL_MS)
    })
    await waitFor(() => expect(result.current.job.status).toBe('running'))

    rerender({ job: makeJob({ status: 'cancelled' }) })
    expect(result.current.job.status).toBe('cancelled')
  })

  it('stops quietly when unmounted mid-request', async () => {
    let finish: (value: unknown) => void = () => undefined
    global.fetch = jest.fn(() => new Promise((done) => (finish = done))) as unknown as typeof fetch
    const onSettled = jest.fn()
    const { unmount } = renderHook(() => useJobPolling(makeJob({ status: 'queued' }), onSettled))

    await act(async () => {
      jest.advanceTimersByTime(POLL_INITIAL_MS)
    })
    unmount()
    finish(jsonResponse({ job: makeJob({ status: 'succeeded' }) }))
    await Promise.resolve()
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('stops quietly when unmounted mid-failure', async () => {
    let fail: (error: Error) => void = () => undefined
    global.fetch = jest.fn(() => new Promise((_, reject) => (fail = reject))) as unknown as typeof fetch
    const { unmount, result } = renderHook(() => useJobPolling(makeJob({ status: 'queued' })))

    await act(async () => {
      jest.advanceTimersByTime(POLL_INITIAL_MS)
    })
    unmount()
    fail(new Error('down'))
    await Promise.resolve()
    expect(result.current.stale).toBe(false)
  })
})

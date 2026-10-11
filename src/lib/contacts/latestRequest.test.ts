/** @jest-environment node */
import { createLatestRequest, isAbortError } from './latestRequest'

describe('createLatestRequest', () => {
  it('aborts the previous request and lets only the newest answer', () => {
    const requests = createLatestRequest()
    const first = requests.begin()
    const second = requests.begin()

    expect(first.signal.aborted).toBe(true)
    expect(first.isCurrent()).toBe(false)
    expect(second.signal.aborted).toBe(false)
    expect(second.isCurrent()).toBe(true)
  })

  it('cancel() retires the current request without starting another', () => {
    const requests = createLatestRequest()
    const ticket = requests.begin()

    requests.cancel()

    expect(ticket.signal.aborted).toBe(true)
    expect(ticket.isCurrent()).toBe(false)
    expect(() => requests.cancel()).not.toThrow()
  })
})

describe('isAbortError', () => {
  it('recognises the abort rejection and nothing else', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isAbortError({ name: 'AbortError' })).toBe(true)
    expect(isAbortError(new Error('network'))).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})

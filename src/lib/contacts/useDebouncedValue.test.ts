import { act, renderHook } from '@testing-library/react'

import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from './useDebouncedValue'

describe('useDebouncedValue', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('starts with the value and only follows it once it settles', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), { initialProps: { value: 'a' } })
    expect(result.current).toBe('a')

    rerender({ value: 'ab' })
    act(() => jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1))
    rerender({ value: 'abc' })
    act(() => jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1))
    expect(result.current).toBe('a')

    act(() => jest.advanceTimersByTime(1))
    expect(result.current).toBe('abc')
  })

  it('accepts a custom delay', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 50), { initialProps: { value: 1 } })
    rerender({ value: 2 })
    act(() => jest.advanceTimersByTime(50))
    expect(result.current).toBe(2)
  })
})

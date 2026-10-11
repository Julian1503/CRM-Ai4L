import { useEffect, useState } from 'react'

/** Contact search waits this long after the last keystroke before querying (audit M1). */
export const SEARCH_DEBOUNCE_MS = 300

/**
 * The value, once it has stopped changing for `delayMs`. The first render returns the
 * value as is, so a page that opens with a search applied does not wait.
 */
export function useDebouncedValue<T>(value: T, delayMs: number = SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

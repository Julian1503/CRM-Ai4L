/**
 * An in-memory stand-in for the App Router, for jsdom tests of pages that keep state in
 * the URL. It mirrors the address into window.history so code reading window.location
 * (Settings, Content Studio) agrees with usePathname/useSearchParams.
 *
 * Usage, in a test file (jest.mock factories may only reference `mock*` names):
 *
 *   jest.mock('next/navigation', () => jest.requireActual('@/test/navigationMock').navigationModule)
 *   jest.mock('next/link', () => jest.requireActual('@/test/navigationMock').linkModule)
 */
import React, { useSyncExternalStore } from 'react'

type Listener = () => void

let current = '/'
let historyStack: string[] = ['/']
let index = 0
const listeners = new Set<Listener>()

function emit() {
  listeners.forEach((listener) => listener())
}

function set(url: string) {
  current = url
  window.history.replaceState(null, '', url)
  emit()
}

function normalise(href: string): string {
  const parsed = new URL(href, `http://localhost${current.split('?')[0]}`)
  return `${parsed.pathname}${parsed.search}`
}

export const mockRouter = {
  push: jest.fn((href: string) => {
    historyStack = [...historyStack.slice(0, index + 1), normalise(href)]
    index = historyStack.length - 1
    set(historyStack[index])
  }),
  replace: jest.fn((href: string) => {
    historyStack = historyStack.map((entry, position) => (position === index ? normalise(href) : entry))
    set(historyStack[index])
  }),
  back: jest.fn(() => {
    if (index === 0) return
    index -= 1
    set(historyStack[index])
    window.dispatchEvent(new PopStateEvent('popstate'))
  }),
  forward: jest.fn(() => {
    if (index >= historyStack.length - 1) return
    index += 1
    set(historyStack[index])
    window.dispatchEvent(new PopStateEvent('popstate'))
  }),
  refresh: jest.fn(),
  prefetch: jest.fn(),
}

/** Starts a test at `url`, with a fresh history. */
export function resetNavigation(url = '/') {
  historyStack = [url]
  index = 0
  Object.values(mockRouter).forEach((fn) => fn.mockClear())
  set(url)
}

/** The address the app is showing. */
export function currentUrl(): string {
  return current
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function useUrl(): string {
  return useSyncExternalStore(subscribe, () => current, () => current)
}

export const navigationModule = {
  useRouter: () => mockRouter,
  usePathname: () => useUrl().split('?')[0],
  useSearchParams: () => {
    const url = useUrl()
    // Memoised per address so effects keyed on the params object behave as in Next.
    return React.useMemo(() => new URLSearchParams(url.split('?')[1] ?? ''), [url])
  },
  redirect: (href: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { href })
  },
}

type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }

/** next/link as a plain anchor that routes through mockRouter on a plain click. */
function MockLink({ href, onClick, children, ...rest }: LinkProps) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        mockRouter.push(href)
      }}
    >
      {children}
    </a>
  )
}

export const linkModule = { __esModule: true, default: MockLink }

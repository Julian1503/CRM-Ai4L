import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'

import { MAX_TOASTS, TOAST_DURATION_MS, ToastProvider, useToast } from './Toast'

function Trigger({ tone, message }: { tone: 'success' | 'error' | 'info'; message: string }) {
  const { notify } = useToast()
  return (
    <button type="button" onClick={() => notify({ tone, message })}>
      notify {message}
    </button>
  )
}

describe('Toast', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('announces a notice in a polite live region', () => {
    render(
      <ToastProvider>
        <Trigger tone="success" message="Saved" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('notify Saved'))

    const region = screen.getByRole('list', { name: 'Notifications' })
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByTestId('toast-success')).toHaveTextContent('Saved')
  })

  it('clears success and info notices on their own', () => {
    render(
      <ToastProvider>
        <Trigger tone="info" message="Heads up" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('notify Heads up'))
    act(() => jest.advanceTimersByTime(TOAST_DURATION_MS))

    expect(screen.queryByText('Heads up')).not.toBeInTheDocument()
  })

  it('keeps an error until it is dismissed', () => {
    render(
      <ToastProvider>
        <Trigger tone="error" message="Sync failed" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('notify Sync failed'))
    act(() => jest.advanceTimersByTime(TOAST_DURATION_MS * 3))
    expect(screen.getByTestId('toast-error')).toHaveTextContent('Sync failed')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }))
    expect(screen.queryByText('Sync failed')).not.toBeInTheDocument()
  })

  it(`keeps at most ${MAX_TOASTS} notices, dropping the oldest`, () => {
    render(
      <ToastProvider>
        {Array.from({ length: MAX_TOASTS + 1 }, (_, index) => (
          <Trigger key={index} tone="error" message={`n${index}`} />
        ))}
      </ToastProvider>,
    )
    for (let index = 0; index <= MAX_TOASTS; index += 1) fireEvent.click(screen.getByText(`notify n${index}`))

    expect(screen.getAllByTestId('toast-error')).toHaveLength(MAX_TOASTS)
    expect(screen.queryByText('n0')).not.toBeInTheDocument()
  })

  it('is a safe no-op outside a provider', () => {
    const { result } = renderHook(() => useToast())
    expect(() => result.current.notify({ tone: 'error', message: 'x' })).not.toThrow()
  })
})

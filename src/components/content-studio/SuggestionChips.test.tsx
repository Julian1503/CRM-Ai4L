import { act, fireEvent, render, screen } from '@testing-library/react'

import { ApiError } from './api'
import SuggestionChips, { type Suggestion } from './SuggestionChips'

const FIRST: Suggestion[] = [
  { key: 'a', label: 'Lead with the date', value: 'Lead with the date' },
  { key: 'b', label: 'Desk', detail: 'A calm desk at dawn', value: 'A calm desk at dawn' },
]
const SECOND: Suggestion[] = [{ key: 'c', label: 'Add a question', value: 'Add a question' }]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SuggestionChips', () => {
  it('waits for a click when not loading on its own', async () => {
    const load = jest.fn(async () => FIRST)
    render(<SuggestionChips title="Prompt ideas" startLabel="Suggest prompts" load={load} onPick={jest.fn()} />)

    expect(load).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest prompts' }))

    expect(await screen.findByRole('button', { name: /Lead with the date/ })).toBeInTheDocument()
    expect(load).toHaveBeenCalledWith(false)
  })

  it('loads on its own, shows a loading state, and fills the field when a chip is picked', async () => {
    const pending = deferred<Suggestion[]>()
    const onPick = jest.fn()
    render(<SuggestionChips title="Suggested instructions" load={() => pending.promise} onPick={onPick} autoLoad />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading suggestions…')
    expect(screen.getByRole('region', { name: 'Suggested instructions' })).toHaveAttribute('aria-busy', 'true')
    await act(async () => pending.resolve(FIRST))

    const chip = screen.getByRole('button', { name: /A calm desk at dawn/ })
    fireEvent.click(chip)

    expect(onPick).toHaveBeenCalledWith('A calm desk at dawn')
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(chip).toHaveAttribute('title', 'A calm desk at dawn')
  })

  it('asks for fresh suggestions with More ideas, keeping the old ones visible meanwhile', async () => {
    const second = deferred<Suggestion[]>()
    const load = jest.fn().mockResolvedValueOnce(FIRST).mockReturnValueOnce(second.promise)
    render(<SuggestionChips title="Ideas" load={load} onPick={jest.fn()} autoLoad />)

    fireEvent.click(await screen.findByRole('button', { name: 'More ideas' }))

    expect(load).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: 'Thinking…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Lead with the date/ })).toBeDisabled()
    await act(async () => second.resolve(SECOND))
    expect(screen.getByRole('button', { name: 'Add a question' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Lead with the date/ })).not.toBeInTheDocument()
  })

  it('stays quiet on failure, explains the rate limit and retries', async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new ApiError('Too many', 429))
      .mockRejectedValueOnce(new Error('Suggestions are unavailable right now. Try again in a moment.'))
      .mockResolvedValueOnce(FIRST)
    render(<SuggestionChips title="Ideas" load={load} onPick={jest.fn()} autoLoad />)

    expect(await screen.findByText(/Too many suggestions in a minute/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/unavailable right now/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /Lead with the date/ })).toBeInTheDocument()
  })

  it('says so when nothing came back', async () => {
    render(<SuggestionChips title="Ideas" load={async () => []} onPick={jest.fn()} autoLoad />)

    expect(await screen.findByText('No suggestions this time.')).toBeInTheDocument()
  })

  it('drops an answer that arrives after the chips are gone', async () => {
    const pending = deferred<Suggestion[]>()
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<SuggestionChips title="Ideas" load={() => pending.promise} onPick={jest.fn()} autoLoad />)

    unmount()
    await act(async () => pending.resolve(FIRST))

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('does not reload when the parent passes a new load function', async () => {
    const load = jest.fn(async () => FIRST)
    const { rerender } = render(<SuggestionChips title="Ideas" load={load} onPick={jest.fn()} autoLoad />)
    await screen.findByRole('button', { name: /Lead with the date/ })

    rerender(<SuggestionChips title="Ideas" load={async () => SECOND} onPick={jest.fn()} autoLoad />)

    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /Lead with the date/ })).toBeInTheDocument()
  })
})

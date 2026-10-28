import { fireEvent, render, screen } from '@testing-library/react'

import { MAX_SELECTED_IDS } from '@/lib/contacts/query'

import BulkContactActions from './BulkContactActions'

const ids = (count: number) => Array.from({ length: count }, (_, i) => `id-${i}`)

describe('BulkContactActions', () => {
  it('renders nothing without a selection, so it can never act on "everyone"', () => {
    const { container } = render(<BulkContactActions selectedIds={[]} onRequest={jest.fn()} onClear={jest.fn()} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('names how many contacts are selected', () => {
    render(<BulkContactActions selectedIds={ids(3)} onRequest={jest.fn()} onClear={jest.fn()} />)

    expect(screen.getByRole('toolbar', { name: 'Selected contacts' })).toHaveTextContent('3 contacts selected')
  })

  it('asks for archive or remove and leaves the confirmation to the page', () => {
    const onRequest = jest.fn()
    render(<BulkContactActions selectedIds={ids(2)} onRequest={onRequest} onClear={jest.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))

    expect(onRequest.mock.calls).toEqual([['archive'], ['remove']])
  })

  it('clears the selection', () => {
    const onClear = jest.fn()
    render(<BulkContactActions selectedIds={ids(1)} onRequest={jest.fn()} onClear={onClear} />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))

    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('refuses a selection larger than one request may carry', () => {
    render(<BulkContactActions selectedIds={ids(MAX_SELECTED_IDS + 1)} onRequest={jest.fn()} onClear={jest.fn()} />)

    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove…' })).toBeDisabled()
    expect(screen.getByText(new RegExp(`at most ${MAX_SELECTED_IDS}`))).toBeInTheDocument()
  })
})

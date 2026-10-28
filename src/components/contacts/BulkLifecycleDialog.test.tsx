import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import BulkLifecycleDialog from './BulkLifecycleDialog'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

beforeEach(() => jest.clearAllMocks())

describe('BulkLifecycleDialog', () => {
  it('renders nothing without a request', () => {
    const { container } = render(<BulkLifecycleDialog request={null} onClose={jest.fn()} onDone={jest.fn()} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('archives the chosen ids in one request and reports how many changed', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ updated: 2, action: 'archive' }))
    const onDone = jest.fn()
    render(
      <BulkLifecycleDialog request={{ action: 'archive', contactIds: ['a', 'b'] }} onClose={jest.fn()} onDone={onDone} />
    )

    expect(screen.getByRole('alertdialog', { name: 'Archive 2 contacts?' })).toBeInTheDocument()
    expect(screen.getByText(/restore them from the Archive/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Archive 2 contacts' }))

    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ action: 'archive', updated: 2, skipped: 0 }))
    expect(mockFetch).toHaveBeenCalledWith('/api/contacts/lifecycle', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ contactIds: ['a', 'b'], action: 'archive' })
  })

  it('warns that removal hides the contact everywhere and names a single contact', () => {
    render(
      <BulkLifecycleDialog
        request={{ action: 'remove', contactIds: ['a'], subject: 'Ada Lovelace' }}
        onClose={jest.fn()}
        onDone={jest.fn()}
      />
    )

    expect(screen.getByRole('alertdialog', { name: 'Remove 1 contact?' })).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText(/only an administrator can bring them back/)).toBeInTheDocument()
  })

  it('keeps the dialog open with the reason when the server refuses', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Contact is in a campaign that is sending.' }, false, 409))
    const onDone = jest.fn()
    render(<BulkLifecycleDialog request={{ action: 'remove', contactIds: ['a'] }} onClose={jest.fn()} onDone={onDone} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove 1 contact' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/campaign that is sending/)
    expect(onDone).not.toHaveBeenCalled()
  })
})

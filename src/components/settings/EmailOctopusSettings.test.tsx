import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import EmailOctopusSettings, { type EmailOctopusStatus } from './EmailOctopusSettings'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

const saved: EmailOctopusStatus = { apiKeyConfigured: true, listId: 'list-1', configured: true, canEdit: true }

function respond(body: unknown, ok = true, status = 200) {
  mockFetch.mockResolvedValue({ ok, status, json: () => Promise.resolve(body) })
}

describe('EmailOctopusSettings (audit H1)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('never shows the saved key, only that one exists', () => {
    render(<EmailOctopusSettings status={saved} onSaved={jest.fn()} />)

    expect(screen.getByLabelText('EmailOctopus API Key')).toHaveValue('')
    expect(screen.getByTestId('api-key-state')).toHaveTextContent(/A key is saved/)
  })

  it('leaves the key unchanged when the field is blank', async () => {
    respond(saved)
    const onSaved = jest.fn()
    render(<EmailOctopusSettings status={saved} onSaved={onSaved} />)

    fireEvent.click(screen.getByRole('button', { name: /save config/i }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved))
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ apiKey: { action: 'unchanged' }, listId: 'list-1' })
  })

  it('clears the key only through the explicit option', async () => {
    respond({ ...saved, apiKeyConfigured: false, configured: false })
    render(<EmailOctopusSettings status={saved} onSaved={jest.fn()} />)

    fireEvent.click(screen.getByLabelText(/Remove the saved key/))
    expect(screen.getByLabelText('EmailOctopus API Key')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /save config/i }))

    await waitFor(() =>
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ apiKey: { action: 'clear' }, listId: 'list-1' })
    )
  })

  it('shows the server refusal and keeps the draft', async () => {
    respond({ error: 'Only an administrator can do that.' }, false, 403)
    render(<EmailOctopusSettings status={saved} onSaved={jest.fn()} />)

    fireEvent.change(screen.getByLabelText('EmailOctopus API Key'), { target: { value: 'new-key' } })
    fireEvent.click(screen.getByRole('button', { name: /save config/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Only an administrator can do that.')
    expect(screen.getByLabelText('EmailOctopus API Key')).toHaveValue('new-key')
  })

  it('says it is still checking before the status arrives', () => {
    render(<EmailOctopusSettings status={null} onSaved={jest.fn()} />)

    expect(screen.getByTestId('api-key-state')).toHaveTextContent(/Checking/)
    expect(screen.getByRole('button', { name: /save config/i })).toBeDisabled()
  })
})

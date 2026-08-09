import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import ArchiveView from './ArchiveView'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

const archived = [
  {
    id: 'c1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    state: 'NSW',
    deleted_at: '2026-06-01T00:00:00.000Z',
    organisation: { name: 'Analytical Engines' },
  },
]

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function routeFetch(handlers: Record<string, unknown>) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url}`

    for (const [pattern, response] of Object.entries(handlers)) {
      if (key.startsWith(pattern)) return response
    }

    return jsonResponse({})
  })
}

const listHandler = {
  'GET /api/contacts?includeArchived=true': jsonResponse({ contacts: archived, total: 1 }),
}

describe('ArchiveView', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    routeFetch(listHandler)
  })

  it('requests only archived contacts', async () => {
    render(<ArchiveView />)

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/contacts?includeArchived=true')
    )
  })

  it('lists archived contacts with the date they were archived', async () => {
    render(<ArchiveView />)

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByText('Analytical Engines')).toBeInTheDocument()
    expect(screen.getByText(/Jun 2026|1 Jun/)).toBeInTheDocument()
  })

  it('says records are kept rather than deleted', async () => {
    // The requirement is archival, not deletion; the screen should say so plainly.
    render(<ArchiveView />)

    expect(await screen.findByText(/kept and can be restored/i)).toBeInTheDocument()
  })

  it('shows an empty state rather than a bare table', async () => {
    routeFetch({
      'GET /api/contacts?includeArchived=true': jsonResponse({ contacts: [], total: 0 }),
    })

    render(<ArchiveView />)

    expect(await screen.findByTestId('archive-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('archive-table')).not.toBeInTheDocument()
  })

  it('restores a contact through the dedicated endpoint', async () => {
    routeFetch({
      ...listHandler,
      'POST /api/contacts/c1': jsonResponse({ ok: true }),
    })

    render(<ArchiveView />)
    fireEvent.click(await screen.findByTestId('restore-c1'))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/contacts/c1', { method: 'POST' })
    )
  })

  it('reloads after a restore so the row disappears', async () => {
    let listCalls = 0
    mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') return jsonResponse({ ok: true })
      listCalls += 1
      return jsonResponse({ contacts: listCalls === 1 ? archived : [], total: listCalls === 1 ? 1 : 0 })
    })

    render(<ArchiveView />)
    fireEvent.click(await screen.findByTestId('restore-c1'))

    expect(await screen.findByTestId('archive-empty')).toBeInTheDocument()
  })

  it('explains an email collision instead of a generic failure', async () => {
    // Restoring a contact whose address was reused violates the partial unique index.
    // That is actionable, so the server's message is surfaced verbatim.
    routeFetch({
      ...listHandler,
      'POST /api/contacts/c1': jsonResponse(
        { error: 'There is already an active contact with that email address.' },
        false,
        409
      ),
    })

    render(<ArchiveView />)
    fireEvent.click(await screen.findByTestId('restore-c1'))

    expect(
      await screen.findByText(/already an active contact with that email/i)
    ).toBeInTheDocument()
  })

  it('surfaces a load failure', async () => {
    routeFetch({
      'GET /api/contacts?includeArchived=true': jsonResponse(
        { error: 'Could not load contacts.' },
        false,
        500
      ),
    })

    render(<ArchiveView />)

    expect(await screen.findByTestId('archive-error')).toHaveTextContent('Could not load')
  })
})

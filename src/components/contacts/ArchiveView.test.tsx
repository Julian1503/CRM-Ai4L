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
    archive_reason: 'manual',
    organisation: { name: 'Analytical Engines' },
  },
]

const optedOut = [
  {
    id: 'c2',
    first_name: 'Grace',
    last_name: 'Hopper',
    email: 'grace@example.com',
    state: 'VIC',
    deleted_at: '2026-07-01T00:00:00.000Z',
    archive_reason: 'opted_out',
    organisation: null,
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

  it('requests only archived contacts, for an explicit page', async () => {
    render(<ArchiveView />)

    // The page must be explicit: /api/contacts always bounds its result set, so
    // omitting it pins the view to page 1 while still reporting the full count.
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/contacts?includeArchived=true&page=1&pageSize=50'
      )
    )
  })

  it('pages through an archive larger than one screen', async () => {
    routeFetch({
      'GET /api/contacts?includeArchived=true': jsonResponse({ contacts: archived, total: 120 }),
    })

    render(<ArchiveView />)

    // waitFor on the *content*, not findBy on the element. The summary node is
    // rendered from the first paint (Pagination keeps the page-size control alive even
    // with no results), so findByTestId resolves immediately against a node still
    // reading "No archived contacts" and the assertion races the fetch.
    await waitFor(() =>
      expect(screen.getByTestId('archive-pagination-position')).toHaveTextContent(
        'Page 1 of 3'
      )
    )

    fireEvent.click(screen.getByTestId('archive-pagination-next'))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/contacts?includeArchived=true&page=2&pageSize=50'
      )
    )
  })

  it('resets to the first page when the page size changes', async () => {
    routeFetch({
      'GET /api/contacts?includeArchived=true': jsonResponse({ contacts: archived, total: 120 }),
    })

    render(<ArchiveView />)

    fireEvent.click(await screen.findByTestId('archive-pagination-next'))
    await waitFor(() => expect(screen.getByTestId('archive-pagination-position')).toHaveTextContent('Page 2'))

    fireEvent.change(screen.getByTestId('archive-pagination-size'), { target: { value: '100' } })

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/contacts?includeArchived=true&page=1&pageSize=100'
      )
    )
  })

  it('steps back a page when the last row on it is restored', async () => {
    routeFetch({
      'GET /api/contacts?includeArchived=true': jsonResponse({ contacts: archived, total: 51 }),
      'POST /api/contacts/c1': jsonResponse({ contact: { id: 'c1' } }),
    })

    render(<ArchiveView />)

    fireEvent.click(await screen.findByTestId('archive-pagination-next'))
    await waitFor(() => expect(screen.getByTestId('archive-pagination-position')).toHaveTextContent('Page 2'))

    // Restoring the only row on the last page would otherwise strand the user on an
    // empty page.
    fireEvent.click(screen.getByTestId('restore-c1'))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/contacts?includeArchived=true&page=1&pageSize=50'
      )
    )
  })

  it('says why each contact is in the archive', async () => {
    // "Archived here" and "opted out" mean different things for the Restore button
    // beside them, and only one of the two is reversible by restoring.
    render(<ArchiveView />)

    expect(await screen.findByText('Archived here')).toBeInTheDocument()
  })

  it('warns before restoring somebody who opted out of every email', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false)

    routeFetch({
      'GET /api/contacts?includeArchived=true': jsonResponse({ contacts: optedOut, total: 1 }),
      'POST /api/contacts/c2': jsonResponse({ ok: true }),
    })

    render(<ArchiveView />)
    expect(await screen.findByText('Opted out of all email')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('restore-c2'))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('not their consent'))
    // Declining the warning must not restore anybody.
    expect(mockFetch).not.toHaveBeenCalledWith('/api/contacts/c2', { method: 'POST' })

    confirmSpy.mockRestore()
  })

  it('restores a manually archived contact without a consent warning', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm')

    routeFetch({
      ...listHandler,
      'POST /api/contacts/c1': jsonResponse({ ok: true }),
    })

    render(<ArchiveView />)
    fireEvent.click(await screen.findByTestId('restore-c1'))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/contacts/c1', { method: 'POST' })
    )
    expect(confirmSpy).not.toHaveBeenCalled()

    confirmSpy.mockRestore()
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

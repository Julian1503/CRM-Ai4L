import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import ArchiveHub from './ArchiveHub'
import { ARCHIVE_SOURCES } from './archiveSources'

const fetchMock = jest.fn()

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body })
}

function route(handlers: Record<string, unknown>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    return json(handlers[key] ?? {})
  })
}

const ARCHIVED_SEGMENT = { id: 'seg-1', name: 'Old NSW leads', description: 'Spring', archived_at: '2026-09-01T00:00:00Z' }

describe('ArchiveHub', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as never
    route({
      'GET /api/contacts': { contacts: [], total: 0 },
      'GET /api/segments': { segments: [ARCHIVED_SEGMENT], total: 1 },
      'GET /api/campaigns': { campaigns: [], total: 0 },
      'PATCH /api/segments/seg-1': { segment: {} },
    })
  })

  it('opens on archived contacts', async () => {
    render(<ArchiveHub />)

    expect(screen.getByTestId('archive-tab-contacts')).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(fetchMock.mock.calls[0][0]).toContain('/api/contacts?includeArchived=true'))
  })

  it('lists archived segments with restore and remove', async () => {
    render(<ArchiveHub />)

    fireEvent.click(screen.getByTestId('archive-tab-segments'))

    expect(await screen.findByText('Old NSW leads')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/segments?archived=true'))).toBe(true)
    expect(screen.getByTestId('archived-segment-seg-1-restore')).toBeInTheDocument()
    expect(screen.getByTestId('archived-segment-seg-1-remove')).toBeInTheDocument()
  })

  it('restores a segment and reloads the list', async () => {
    render(<ArchiveHub />)
    fireEvent.click(screen.getByTestId('archive-tab-segments'))
    fireEvent.click(await screen.findByTestId('archived-segment-seg-1-restore'))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/segments/seg-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ archived: false }) })
      )
    )
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/segments?')).length).toBe(2)
    )
  })

  it('says so when a kind has nothing archived', async () => {
    render(<ArchiveHub />)

    fireEvent.click(screen.getByTestId('archive-tab-campaigns'))

    expect(await screen.findByTestId('archived-campaign-empty')).toBeInTheDocument()
  })

  it('shows a failed load instead of an empty archive', async () => {
    fetchMock.mockImplementation(() => json({ error: 'Database unavailable.' }, 500))
    render(<ArchiveHub />)

    fireEvent.click(screen.getByTestId('archive-tab-segments'))

    expect(await screen.findByTestId('archived-segment-error')).toHaveTextContent('Database unavailable.')
  })
})

describe('ARCHIVE_SOURCES', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as never
  })

  it('picks only archived templates and pages them locally', async () => {
    fetchMock.mockReturnValue(
      json({
        templates: [
          { id: 't1', name: 'Live', archived_at: null },
          { id: 't2', name: 'Old', archived_at: '2026-09-01T00:00:00Z', description: 'August' },
          { id: 't3', name: 'Older', archived_at: '2026-08-01T00:00:00Z', provider_automation_id: 'auto-3' },
        ],
      })
    )

    const first = await ARCHIVE_SOURCES.templates.load(1, 1)
    const second = await ARCHIVE_SOURCES.templates.load(2, 1)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/templates?includeArchived=true')
    expect(first).toEqual({ total: 2, records: [expect.objectContaining({ id: 't2', detail: 'August' })] })
    expect(second.records).toEqual([expect.objectContaining({ id: 't3', detail: 'auto-3' })])
  })

  it('describes an archived campaign by status and segment', async () => {
    fetchMock.mockReturnValue(
      json({
        campaigns: [{ id: 'c1', name: 'August', status: 'sent', archived_at: 'x', segment: { name: 'NSW' } }],
        total: 1,
      })
    )

    const page = await ARCHIVE_SOURCES.campaigns.load(1, 50)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/campaigns?archived=true&page=1&pageSize=50')
    expect(page.records[0].detail).toBe('Sent · NSW')
  })

  it('names the schedule frequency', async () => {
    fetchMock.mockReturnValue(
      json({ schedules: [{ id: 's1', name: 'Monthly', frequency: 'monthly', archived_at: 'x' }] })
    )

    const page = await ARCHIVE_SOURCES.schedules.load(1, 50)

    expect(page.records[0]).toMatchObject({ id: 's1', detail: 'Monthly' })
    expect(ARCHIVE_SOURCES.schedules.endpoint('s1')).toBe('/api/newsletter-schedules/s1')
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import SegmentsPanel, { describeCriteria } from './SegmentsPanel'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

const JOB_TYPES = [{ id: 'job-1', name: 'Electrician' }]

function routeFetch(handlers: Record<string, unknown>) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const match = Object.entries(handlers)
      .sort(([left], [right]) => right.length - left.length)
      .find(([pattern]) => key.startsWith(pattern))
    return match ? match[1] : jsonResponse({})
  })
}

const defaults = {
  'GET /api/segments?': jsonResponse({
    segments: [{ id: 'seg-1', name: 'NSW sparkies', description: null, definition: { state: 'NSW', jobTypeId: 'job-1' } }],
    total: 1,
  }),
  'POST /api/segments/preview': jsonResponse({ total: 5, truncated: false, estimatedSendMs: 0 }),
  'GET /api/segments/options': jsonResponse({
    services: [{ id: 'svc-1', name: 'Coaching' }],
    organisations: [{ id: 'org-1', name: 'Acme' }],
    sources: ['newsletter', 'import', 'manual'],
  }),
  'POST /api/segments': jsonResponse({ segment: { id: 'seg-2' } }),
  'GET /api/segments/seg-1': jsonResponse({
    segment: { id: 'seg-1', name: 'NSW sparkies', description: null, definition: {} },
    counts: { newsletter: 5, programs: 0 },
    overrides: { included: 0, excluded: 0 },
    lockedBy: [],
  }),
}

describe('describeCriteria', () => {
  it('reads a definition in words, with names', () => {
    expect(
      describeCriteria({ status: 'lead', state: 'NSW', jobTypeId: 'job-1', source: 'import' }, JOB_TYPES)
    ).toBe('Leads · in NSW · Electrician · imported')
  })

  it('says who an empty segment reaches', () => {
    expect(describeCriteria({}, JOB_TYPES)).toBe('All subscribed contacts')
  })
})

describe('SegmentsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    routeFetch(defaults)
  })

  it('lists segments with their criteria in words', async () => {
    render(<SegmentsPanel jobTypes={JOB_TYPES} onChanged={jest.fn()} />)

    expect(await screen.findByText('in NSW · Electrician')).toBeInTheDocument()
  })

  it('creates a segment with the extra criteria and tells the campaign form', async () => {
    const onChanged = jest.fn()
    render(<SegmentsPanel jobTypes={JOB_TYPES} onChanged={onChanged} />)

    fireEvent.change(await screen.findByTestId('segment-name'), { target: { value: 'Coaching clients' } })
    fireEvent.click(screen.getByTestId('segment-more'))
    await screen.findByRole('option', { name: 'Coaching' })
    fireEvent.change(screen.getByTestId('segment-service'), { target: { value: 'svc-1' } })
    fireEvent.change(screen.getByTestId('segment-source'), { target: { value: 'import' } })
    fireEvent.change(screen.getByTestId('segment-created-from'), { target: { value: '2026-01-01' } })
    fireEvent.click(screen.getByTestId('create-segment'))

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(([url, init]) => url === '/api/segments' && init?.method === 'POST')
      expect(JSON.parse(call![1].body)).toEqual({
        name: 'Coaching clients',
        definition: { serviceId: 'svc-1', source: 'import', createdFrom: '2026-01-01' },
      })
    })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('searches organisations by name', async () => {
    render(<SegmentsPanel jobTypes={JOB_TYPES} onChanged={jest.fn()} />)

    fireEvent.click(await screen.findByTestId('segment-more'))
    fireEvent.change(screen.getByTestId('segment-org-search'), { target: { value: 'ac' } })

    await waitFor(() =>
      expect(mockFetch.mock.calls.some(([url]) => url === '/api/segments/options?org=ac')).toBe(true)
    )
    expect(await screen.findByRole('option', { name: 'Acme' })).toBeInTheDocument()
  })

  it('clearing a criterion removes it rather than storing an empty value', async () => {
    render(<SegmentsPanel jobTypes={JOB_TYPES} onChanged={jest.fn()} />)

    fireEvent.change(await screen.findByTestId('segment-state'), { target: { value: 'VIC' } })
    fireEvent.change(screen.getByTestId('segment-state'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('segment-name'), { target: { value: 'Everyone' } })
    fireEvent.click(screen.getByTestId('create-segment'))

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(([url, init]) => url === '/api/segments' && init?.method === 'POST')
      expect(JSON.parse(call![1].body).definition).toEqual({})
    })
  })

  it('opens a segment to see who is in it', async () => {
    render(<SegmentsPanel jobTypes={JOB_TYPES} onChanged={jest.fn()} />)

    fireEvent.click(await screen.findByTestId('open-segment-seg-1'))

    expect(await screen.findByTestId('segment-drawer')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('close-segment'))
    await waitFor(() => expect(screen.queryByTestId('segment-drawer')).toBeNull())
  })
})

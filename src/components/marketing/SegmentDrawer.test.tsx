import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import SegmentDrawer from './SegmentDrawer'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

const DETAIL = {
  segment: { id: 'seg-1', name: 'NSW leads', description: null, definition: { state: 'NSW' } },
  counts: { newsletter: 12, programs: 4 },
  overrides: { included: 1, excluded: 2 },
  lockedBy: [],
}

const MEMBERS = {
  members: [
    {
      id: 'c1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      organisation: 'Analytical',
      state: 'NSW',
      status: 'lead',
      is_included: true,
    },
  ],
  total: 1,
}

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
  'GET /api/segments/seg-1': jsonResponse(DETAIL),
  'GET /api/segments/seg-1/members': jsonResponse(MEMBERS),
  'GET /api/segments/seg-1/overrides': jsonResponse({
    overrides: [
      {
        contact_id: 'c9',
        mode: 'exclude',
        reason: null,
        created_at: '2026-09-01',
        contact: { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com', deleted_at: null },
      },
    ],
    total: 1,
  }),
  'POST /api/segments/seg-1/overrides': jsonResponse({
    override: {},
    consent: { newsletter: false, programs: true },
  }),
  'DELETE /api/segments/seg-1/overrides/c9': jsonResponse({ removed: 'c9' }),
  'POST /api/segments/preview': jsonResponse({ total: 9 }),
}

function calls(url: string, method: string) {
  return mockFetch.mock.calls.filter(([called, init]) => called === url && (init?.method ?? 'GET') === method)
}

function renderDrawer(overrides: Record<string, unknown> = {}) {
  routeFetch({ ...defaults, ...overrides })
  const onClose = jest.fn()
  const onChanged = jest.fn()
  render(<SegmentDrawer segmentId="seg-1" jobTypes={[]} onClose={onClose} onChanged={onChanged} />)
  return { onClose, onChanged }
}

describe('SegmentDrawer', () => {
  beforeEach(() => jest.clearAllMocks())

  it('summarises reach on each stream and the manual decisions', async () => {
    renderDrawer()

    expect(await screen.findByTestId('segment-drawer-counts')).toHaveTextContent(
      '12 newsletter · 4 courses & training · 1 added · 2 excluded'
    )
  })

  it('lists members, marking those added by hand', async () => {
    renderDrawer()

    const row = await screen.findByTestId('member-c1')
    expect(row).toHaveTextContent('Ada Lovelace')
    expect(row).toHaveTextContent('Analytical')
    expect(within(row).getByText('Added by hand')).toBeInTheDocument()
  })

  it('lists members for the stream chosen', async () => {
    renderDrawer()

    fireEvent.change(await screen.findByTestId('members-stream'), { target: { value: 'programs' } })

    await waitFor(() =>
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/members?stream=programs'))).toBe(true)
    )
  })

  it('excludes a member and refreshes', async () => {
    const { onChanged } = renderDrawer()

    fireEvent.click(await screen.findByTestId('exclude-c1'))

    await waitFor(() =>
      expect(JSON.parse(calls('/api/segments/seg-1/overrides', 'POST')[0][1].body)).toEqual({
        contactId: 'c1',
        mode: 'exclude',
      })
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('restores an excluded person', async () => {
    renderDrawer()

    fireEvent.click(await screen.findByTestId('segment-tab-decisions'))
    fireEvent.click(await screen.findByTestId('undo-c9'))

    await waitFor(() => expect(calls('/api/segments/seg-1/overrides/c9', 'DELETE')).toHaveLength(1))
  })

  it('adds someone by hand and says what their consent allows', async () => {
    renderDrawer({
      'GET /api/contacts': jsonResponse({
        contacts: [
          {
            id: 'c5',
            first_name: 'Alan',
            last_name: 'Turing',
            email: 'alan@example.com',
            subscribed_to_newsletter: false,
            subscribed_to_programs: true,
          },
        ],
      }),
    })

    fireEvent.click(await screen.findByTestId('segment-tab-add'))
    fireEvent.change(screen.getByTestId('add-people-search'), { target: { value: 'alan' } })

    const candidate = await screen.findByTestId('candidate-c5')
    expect(candidate).toHaveTextContent(/only receive course & training emails/i)

    fireEvent.click(within(candidate).getByTestId('include-c5'))

    await waitFor(() =>
      expect(JSON.parse(calls('/api/segments/seg-1/overrides', 'POST')[0][1].body)).toEqual({
        contactId: 'c5',
        mode: 'include',
      })
    )
    expect(await within(candidate).findByText('Added')).toBeInTheDocument()
  })

  it('saves edited criteria', async () => {
    renderDrawer({ 'PATCH /api/segments/seg-1': jsonResponse({ segment: DETAIL.segment }) })

    fireEvent.click(await screen.findByTestId('segment-tab-filters'))
    fireEvent.change(await screen.findByTestId('edit-segment-state'), { target: { value: 'VIC' } })
    fireEvent.click(screen.getByTestId('save-segment'))

    await waitFor(() =>
      expect(JSON.parse(calls('/api/segments/seg-1', 'PATCH')[0][1].body)).toEqual({
        name: 'NSW leads',
        description: '',
        definition: { state: 'VIC' },
      })
    )
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
  })

  it('previews edits with the segment’s manual decisions counted', async () => {
    renderDrawer()

    fireEvent.click(await screen.findByTestId('segment-tab-filters'))

    await waitFor(() =>
      expect(JSON.parse(calls('/api/segments/preview', 'POST')[0][1].body)).toMatchObject({
        segmentId: 'seg-1',
      })
    )
  })

  it('locks every change while a campaign using it is approved or sending', async () => {
    renderDrawer({
      'GET /api/segments/seg-1': jsonResponse({
        ...DETAIL,
        lockedBy: [{ id: 'k1', name: 'August offer', status: 'approved' }],
      }),
    })

    expect(await screen.findByTestId('segment-locked')).toHaveTextContent('“August offer”')
    expect(await screen.findByTestId('exclude-c1')).toBeDisabled()

    fireEvent.click(screen.getByTestId('segment-tab-filters'))
    expect(await screen.findByTestId('save-segment')).toBeDisabled()
  })

  it('shows a refusal from the server', async () => {
    renderDrawer({
      'POST /api/segments/seg-1/overrides': jsonResponse({ error: 'Segment is locked.' }, false, 409),
    })

    fireEvent.click(await screen.findByTestId('exclude-c1'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Segment is locked.')
  })

  it('closes on Escape and on the backdrop', async () => {
    const { onClose } = renderDrawer()

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(await screen.findByTestId('segment-drawer-backdrop'))

    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('SegmentDrawer archive and remove', () => {
  beforeEach(() => mockFetch.mockReset())

  it('archives from the header, then refreshes the list and closes', async () => {
    routeFetch({ ...defaults, 'PATCH /api/segments/seg-1': jsonResponse({ segment: {} }) })
    const onChanged = jest.fn()
    const onClose = jest.fn()

    render(<SegmentDrawer segmentId="seg-1" jobTypes={[]} onClose={onClose} onChanged={onChanged} />)

    fireEvent.click(await screen.findByTestId('segment-archive'))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onChanged).toHaveBeenCalled()
    expect(calls('/api/segments/seg-1', 'PATCH')[0][1].body).toBe(JSON.stringify({ archived: true }))
  })

  it('disables both and says why while the segment is in use', async () => {
    routeFetch({
      ...defaults,
      'GET /api/segments/seg-1': jsonResponse({
        ...DETAIL,
        lifecycle: {
          canArchive: false,
          canRestore: false,
          canRemove: false,
          reason: 'This segment is used by campaign "August offer". Archive those first.',
        },
      }),
    })

    render(<SegmentDrawer segmentId="seg-1" jobTypes={[]} onClose={jest.fn()} onChanged={jest.fn()} />)

    expect(await screen.findByTestId('segment-blocked')).toHaveTextContent('"August offer"')
    expect(screen.getByTestId('segment-archive')).toBeDisabled()
    expect(screen.getByTestId('segment-remove')).toBeDisabled()
  })
})


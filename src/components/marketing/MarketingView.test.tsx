import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import MarketingView from './MarketingView'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

/** Routes each request to a canned response, so tests state intent not call order. */
function routeFetch(handlers: Record<string, unknown>) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET'
    const key = `${method} ${url}`

    for (const [pattern, response] of Object.entries(handlers)) {
      if (key.startsWith(pattern)) {
        return response as ReturnType<typeof jsonResponse>
      }
    }

    return jsonResponse({})
  })
}

const defaultHandlers = {
  'GET /api/segments': jsonResponse({
    segments: [{ id: 'seg-1', name: 'NSW leads', description: null, definition: { state: 'NSW' } }],
  }),
  'GET /api/campaigns': jsonResponse({
    campaigns: [
      {
        id: 'camp-1',
        name: 'August offer',
        status: 'in_review',
        segment_id: 'seg-1',
        provider_automation_id: 'auto-1',
        segment: { name: 'NSW leads' },
      },
    ],
  }),
  'POST /api/segments/preview': jsonResponse({
    total: 42,
    truncated: false,
    estimatedSendMs: 0,
  }),
}

const jobTypes = [{ id: 'job-1', name: 'Electrician' }]

describe('MarketingView', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    routeFetch(defaultHandlers)
  })

  it('explains that the email is authored in EmailOctopus, not here', async () => {
    // The single most surprising constraint. Burying it would strand the user with a
    // campaign that can never send.
    render(<MarketingView jobTypes={jobTypes} />)

    expect(await screen.findByText(/Started via API/)).toBeInTheDocument()
  })

  it('warns that segments exclude unsubscribed contacts', async () => {
    render(<MarketingView jobTypes={jobTypes} />)

    expect(
      await screen.findByText(/exclude archived contacts and anyone not subscribed/i)
    ).toBeInTheDocument()
  })

  it('lists existing segments and campaigns', async () => {
    render(<MarketingView jobTypes={jobTypes} />)

    expect(await screen.findByText('August offer')).toBeInTheDocument()

    // The segment name appears twice by design: once in the segment list, once as an
    // option in the campaign's segment picker.
    await waitFor(() => expect(screen.getAllByText('NSW leads').length).toBeGreaterThan(1))
    expect(screen.getByRole('option', { name: 'NSW leads' })).toBeInTheDocument()
  })

  it('shows the live audience count', async () => {
    render(<MarketingView jobTypes={jobTypes} />)

    await waitFor(() => expect(screen.getByTestId('segment-preview')).toHaveTextContent('42'))
  })

  it('warns when a segment exceeds the send cap', async () => {
    // Silently sending to the first 10k of a larger segment would look complete.
    routeFetch({
      ...defaultHandlers,
      'POST /api/segments/preview': jsonResponse({
        total: 25_000,
        truncated: true,
        estimatedSendMs: 2_490_000,
      }),
    })

    render(<MarketingView jobTypes={jobTypes} />)

    expect(await screen.findByText(/Capped/i)).toBeInTheDocument()
  })

  it('shows how long a send will take', async () => {
    routeFetch({
      ...defaultHandlers,
      'POST /api/segments/preview': jsonResponse({
        total: 10_000,
        truncated: false,
        estimatedSendMs: 990_000,
      }),
    })

    render(<MarketingView jobTypes={jobTypes} />)

    // ~16.5 minutes for 10k, which is the real consequence of a per-contact send.
    expect(await screen.findByText(/17 minutes|16 minutes/)).toBeInTheDocument()
  })

  it('re-counts when the definition changes', async () => {
    render(<MarketingView jobTypes={jobTypes} />)

    await waitFor(() => expect(screen.getByTestId('segment-preview')).toHaveTextContent('42'))
    const before = mockFetch.mock.calls.filter(([url]) =>
      String(url).includes('/preview')
    ).length

    fireEvent.change(screen.getByTestId('segment-state'), { target: { value: 'VIC' } })

    await waitFor(() => {
      const after = mockFetch.mock.calls.filter(([url]) =>
        String(url).includes('/preview')
      ).length
      expect(after).toBeGreaterThan(before)
    })
  })

  it('creates a segment with the current definition', async () => {
    render(<MarketingView jobTypes={jobTypes} />)

    fireEvent.change(await screen.findByTestId('segment-name'), {
      target: { value: 'VIC electricians' },
    })
    fireEvent.change(screen.getByTestId('segment-state'), { target: { value: 'VIC' } })
    fireEvent.change(screen.getByTestId('segment-job-type'), { target: { value: 'job-1' } })
    fireEvent.click(screen.getByTestId('create-segment'))

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(
        ([url, init]) => url === '/api/segments' && init?.method === 'POST'
      )
      expect(call).toBeDefined()
      expect(JSON.parse(call![1].body)).toMatchObject({
        name: 'VIC electricians',
        definition: { state: 'VIC', jobTypeId: 'job-1' },
      })
    })
  })

  it('will not save a segment without a name', async () => {
    render(<MarketingView jobTypes={jobTypes} />)

    expect(await screen.findByTestId('create-segment')).toBeDisabled()
  })

  it('approves through the dedicated endpoint', async () => {
    render(<MarketingView jobTypes={jobTypes} />)

    fireEvent.click(await screen.findByTestId('approve-camp-1'))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/campaigns/camp-1/approve',
        expect.objectContaining({ method: 'POST' })
      )
    )
  })

  it('surfaces a refused approval instead of failing silently', async () => {
    routeFetch({
      ...defaultHandlers,
      'POST /api/campaigns/camp-1/approve': jsonResponse(
        { error: 'Set the provider automation id before approving.' },
        false,
        409
      ),
    })

    render(<MarketingView jobTypes={jobTypes} />)
    fireEvent.click(await screen.findByTestId('approve-camp-1'))

    expect(
      await screen.findByText(/Set the provider automation id before approving/)
    ).toBeInTheDocument()
  })

  it('keeps calling send until the server reports no more work', async () => {
    // Sending is chunked because it is one API call per recipient; stopping after the
    // first chunk would silently deliver to a fraction of the segment.
    let sendCalls = 0
    mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      const key = `${init?.method ?? 'GET'} ${url}`

      if (key === 'POST /api/campaigns/camp-1/send') {
        sendCalls += 1
        return jsonResponse({ hasMore: sendCalls < 3, pending: 3 - sendCalls })
      }
      if (key.startsWith('GET /api/segments')) return defaultHandlers['GET /api/segments']
      if (key.startsWith('GET /api/campaigns')) {
        return jsonResponse({
          campaigns: [
            {
              id: 'camp-1',
              name: 'August offer',
              status: 'approved',
              segment_id: 'seg-1',
              provider_automation_id: 'auto-1',
              segment: { name: 'NSW leads' },
            },
          ],
        })
      }
      return jsonResponse({})
    })

    render(<MarketingView jobTypes={jobTypes} />)
    fireEvent.click(await screen.findByTestId('send-camp-1'))

    await waitFor(() => expect(sendCalls).toBe(3))
  })

  it('reports a send failure rather than appearing to succeed', async () => {
    routeFetch({
      ...defaultHandlers,
      'GET /api/campaigns': jsonResponse({
        campaigns: [
          {
            id: 'camp-1',
            name: 'August offer',
            status: 'approved',
            segment_id: 'seg-1',
            provider_automation_id: 'auto-1',
            segment: { name: 'NSW leads' },
          },
        ],
      }),
      'POST /api/campaigns/camp-1/send': jsonResponse(
        { error: 'EmailOctopus credentials are not configured in Settings.' },
        false,
        409
      ),
    })

    render(<MarketingView jobTypes={jobTypes} />)
    fireEvent.click(await screen.findByTestId('send-camp-1'))

    expect(await screen.findByText(/credentials are not configured/i)).toBeInTheDocument()
  })

  describe('campaign creation', () => {
    it('will not save a campaign without a name', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      expect(await screen.findByTestId('create-campaign')).toBeDisabled()
    })

    it('posts the name, segment and automation id', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      fireEvent.change(await screen.findByTestId('campaign-name'), {
        target: { value: 'August offer' },
      })
      fireEvent.change(screen.getByTestId('campaign-segment'), {
        target: { value: 'seg-1' },
      })
      fireEvent.change(screen.getByTestId('campaign-automation'), {
        target: { value: 'auto-9' },
      })
      fireEvent.click(screen.getByTestId('create-campaign'))

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(
          (entry) => entry[0] === '/api/campaigns' && entry[1]?.method === 'POST'
        )
        expect(call).toBeDefined()
        expect(JSON.parse(call![1].body)).toEqual({
          name: 'August offer',
          segmentId: 'seg-1',
          providerAutomationId: 'auto-9',
        })
      })
    })

    it('surfaces a refused creation', async () => {
      routeFetch({
        ...defaultHandlers,
        'POST /api/campaigns': jsonResponse({ error: 'That name is taken.' }, false, 409),
      })

      render(<MarketingView jobTypes={jobTypes} />)
      fireEvent.change(await screen.findByTestId('campaign-name'), {
        target: { value: 'August offer' },
      })
      fireEvent.click(screen.getByTestId('create-campaign'))

      expect(await screen.findByText('That name is taken.')).toBeInTheDocument()
    })
  })

  describe('review flow', () => {
    it('moves a draft into review through PATCH, not the approve endpoint', async () => {
      routeFetch({
        ...defaultHandlers,
        'GET /api/campaigns': jsonResponse({
          campaigns: [
            {
              id: 'camp-1',
              name: 'August offer',
              status: 'draft',
              segment_id: 'seg-1',
              provider_automation_id: 'auto-1',
              merge_fields: {},
              segment: { name: 'NSW leads' },
            },
          ],
        }),
      })

      render(<MarketingView jobTypes={jobTypes} />)
      fireEvent.click(await screen.findByText('Send for review'))

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(
          (entry) => entry[0] === '/api/campaigns/camp-1' && entry[1]?.method === 'PATCH'
        )
        expect(JSON.parse(call![1].body)).toEqual({ status: 'in_review' })
      })
    })
  })

  describe('copy editor', () => {
    it('stays closed until asked for', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      await screen.findByTestId('review-copy-camp-1')
      expect(screen.queryByTestId('campaign-copy-editor')).toBeNull()
    })

    it('opens and closes on the same control', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      const toggle = await screen.findByTestId('review-copy-camp-1')
      fireEvent.click(toggle)
      expect(screen.getByTestId('campaign-copy-editor')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('review-copy-camp-1'))
      expect(screen.queryByTestId('campaign-copy-editor')).toBeNull()
    })

    it('reports its expanded state to assistive technology', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      const toggle = await screen.findByTestId('review-copy-camp-1')
      expect(toggle).toHaveAttribute('aria-expanded', 'false')

      fireEvent.click(toggle)
      expect(screen.getByTestId('review-copy-camp-1')).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    })

    it('locks the copy of a campaign already under review', async () => {
      // The default fixture campaign is in_review, so its copy must not be editable --
      // rewriting it would leave the approval attributed to text nobody read.
      render(<MarketingView jobTypes={jobTypes} />)

      fireEvent.click(await screen.findByTestId('review-copy-camp-1'))

      expect(screen.getByTestId('copy-locked')).toBeInTheDocument()
    })

    it('leaves a draft campaign editable', async () => {
      routeFetch({
        ...defaultHandlers,
        'GET /api/campaigns': jsonResponse({
          campaigns: [
            {
              id: 'camp-1',
              name: 'August offer',
              status: 'draft',
              segment_id: 'seg-1',
              provider_automation_id: 'auto-1',
              merge_fields: {},
              segment: { name: 'NSW leads' },
            },
          ],
        }),
      })

      render(<MarketingView jobTypes={jobTypes} />)
      fireEvent.click(await screen.findByTestId('review-copy-camp-1'))

      expect(screen.queryByTestId('copy-locked')).toBeNull()
      expect(screen.getByTestId('generate-copy')).toBeEnabled()
    })
  })
})

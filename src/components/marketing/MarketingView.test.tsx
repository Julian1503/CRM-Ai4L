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

    for (const [pattern, response] of Object.entries(handlers).sort(
      ([left], [right]) => right.length - left.length
    )) {
      if ((key.includes('/audience') || key.includes('/preflight')) && !pattern.includes('/audience') && !pattern.includes('/preflight')) continue
      if (key.startsWith(pattern)) {
        return response as ReturnType<typeof jsonResponse>
      }
    }

    if (key.startsWith('GET /api/campaigns/') && key.includes('/preflight')) {
      return jsonResponse({ total: 1, recipients: [] })
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
        consent_stream: 'newsletter',
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

  it('warns that segments exclude archived and non-consenting contacts', async () => {
    render(<MarketingView jobTypes={jobTypes} />)

    expect(
      await screen.findByText(/exclude archived contacts and anyone who has not agreed/i)
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

  it('counts each filter option next to its label', async () => {
    // Without the numbers the only way to learn a combination is empty is to save the
    // segment and read the preview.
    routeFetch({
      ...defaultHandlers,
      'POST /api/segments/preview': jsonResponse({
        total: 5,
        truncated: false,
        estimatedSendMs: 0,
        facets: {
          state: { '': 9, NSW: 5, VIC: 3 },
          jobType: { '': 5, 'job-1': 2 },
          status: { '': 5, lead: 3 },
          truncated: false,
        },
      }),
    })

    render(<MarketingView jobTypes={jobTypes} />)

    expect(await screen.findByRole('option', { name: 'NSW (5)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Any state (9)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Electrician (2)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Lead (3)' })).toBeInTheDocument()
    // Counted but matched by nobody -- an explicit zero, not a missing number.
    expect(screen.getByRole('option', { name: 'Customer (0)' })).toBeInTheDocument()
  })

  it('leaves the options bare until the first count arrives', async () => {
    // A zero rendered while the request is in flight reads as "empty segment".
    routeFetch({ ...defaultHandlers, 'POST /api/segments/preview': jsonResponse({}, false, 500) })

    render(<MarketingView jobTypes={jobTypes} />)

    expect(await screen.findByRole('option', { name: 'Any state' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Electrician' })).toBeInTheDocument()
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

  it('archives a campaign in review and reloads the list', async () => {
    routeFetch({ ...defaultHandlers, 'PATCH /api/campaigns/camp-1': jsonResponse({ campaign: {} }) })
    render(<MarketingView jobTypes={jobTypes} />)

    fireEvent.click(await screen.findByTestId('campaign-camp-1-archive'))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/campaigns/camp-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ archived: true }) })
      )
    )
    await waitFor(() =>
      expect(mockFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/campaigns?')).length).toBeGreaterThan(1)
    )
  })

  it('will not archive or remove an approved campaign, and says why', async () => {
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
    })

    render(<MarketingView jobTypes={jobTypes} />)

    expect(await screen.findByTestId('campaign-camp-1-archive')).toBeDisabled()
    expect(screen.getByTestId('campaign-camp-1-remove')).toBeDisabled()
    expect(screen.getByTestId('campaign-camp-1-blocked')).toHaveTextContent('approved')
  })

  it('checks the live audience before sending', async () => {
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
      'GET /api/campaigns/camp-1/preflight': jsonResponse({ total: 7, ready: true }),
      'POST /api/campaigns/camp-1/send': jsonResponse({ hasMore: false, sent: 7, failed: 0 }),
    })

    render(<MarketingView jobTypes={jobTypes} />)
    fireEvent.click(await screen.findByTestId('send-camp-1'))

    await waitFor(() => expect(screen.getByTestId('send-confirm-dialog')).toHaveTextContent('7'))
    expect(mockFetch).not.toHaveBeenCalledWith(
      '/api/campaigns/camp-1/send',
      expect.objectContaining({ method: 'POST' })
    )

    fireEvent.click(screen.getByTestId('confirm-send'))
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/campaigns/camp-1/send',
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

      if (key.startsWith('GET /api/campaigns/camp-1/preflight')) {
        return jsonResponse({ total: 1, recipients: [] })
      }
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
    const confirmButton = await screen.findByTestId('confirm-send')
    await waitFor(() => expect(confirmButton).not.toBeDisabled())
    fireEvent.click(confirmButton)

    await waitFor(() => expect(sendCalls).toBe(3))
  })

  describe('the recipient list', () => {
    it('opens a dialog naming who the campaign goes to', async () => {
      // Before this the audience was a number: nothing in the app could name one of
      // the people a campaign was about to email.
      routeFetch({
        'GET /api/campaigns/camp-1/audience': jsonResponse({
          source: 'segment',
          run: 1,
          segmentName: 'NSW leads',
          truncated: false,
          page: 1,
          pageSize: 25,
          total: 1,
          recipients: [
            {
              contactId: 'c1',
              firstName: 'Ada',
              lastName: 'Lovelace',
              email: 'ada@example.com',
              status: 'planned',
              error: null,
            },
          ],
        }),
        ...defaultHandlers,
      })

      render(<MarketingView jobTypes={jobTypes} />)
      fireEvent.click(await screen.findByTestId('audience-camp-1'))

      expect(await screen.findByText('ada@example.com')).toBeInTheDocument()
      expect(screen.getByRole('dialog')).toHaveAccessibleName('August offer')
    })

    it('closes without leaving the list behind', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      fireEvent.click(await screen.findByTestId('audience-camp-1'))
      fireEvent.click(await screen.findByTestId('close-audience'))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('reports a failed read inside the dialog', async () => {
      routeFetch({
        'GET /api/campaigns/camp-1/audience': jsonResponse(
          { error: 'Could not load the campaign audience.' },
          false,
          500
        ),
        ...defaultHandlers,
      })

      render(<MarketingView jobTypes={jobTypes} />)
      fireEvent.click(await screen.findByTestId('audience-camp-1'))

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load the campaign audience.'
      )
    })
  })

  describe('sending a campaign again', () => {
    const sentCampaign = {
      campaigns: [
        {
          id: 'camp-1',
          name: 'August offer',
          status: 'sent',
          segment_id: 'seg-1',
          provider_automation_id: 'auto-1',
          segment: { name: 'NSW leads' },
        },
      ],
    }

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('re-opens the campaign after the operator confirms', async () => {
      const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true)
      routeFetch({ ...defaultHandlers, 'GET /api/campaigns': jsonResponse(sentCampaign) })

      render(<MarketingView jobTypes={jobTypes} />)
      fireEvent.click(await screen.findByTestId('reopen-camp-1'))

      await waitFor(() =>
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/campaigns/camp-1/reopen',
          expect.objectContaining({ method: 'POST' })
        )
      )

      // Naming the provider-side setting matters: without "Allow contacts to repeat"
      // the second send is rejected per recipient and nothing arrives.
      expect(confirm.mock.calls[0][0]).toMatch(/Allow contacts to repeat/)
      expect(confirm.mock.calls[0][0]).toMatch(/back to draft/)
    })

    it('does nothing when the operator backs out', async () => {
      // The confirmation is the last gate before real mail goes to people who already
      // received this campaign once.
      jest.spyOn(window, 'confirm').mockReturnValue(false)
      routeFetch({ ...defaultHandlers, 'GET /api/campaigns': jsonResponse(sentCampaign) })

      render(<MarketingView jobTypes={jobTypes} />)
      fireEvent.click(await screen.findByTestId('reopen-camp-1'))

      await waitFor(() => expect(screen.getByTestId('reopen-camp-1')).not.toBeDisabled())
      expect(
        mockFetch.mock.calls.filter(([url]) => String(url).includes('/reopen'))
      ).toHaveLength(0)
    })

    it('surfaces a refusal from the server', async () => {
      jest.spyOn(window, 'confirm').mockReturnValue(true)
      routeFetch({
        'POST /api/campaigns/camp-1/reopen': jsonResponse(
          { error: 'This campaign was already re-opened.' },
          false,
          409
        ),
        ...defaultHandlers,
        'GET /api/campaigns': jsonResponse(sentCampaign),
      })

      render(<MarketingView jobTypes={jobTypes} />)
      fireEvent.click(await screen.findByTestId('reopen-camp-1'))

      expect(await screen.findByRole('alert')).toHaveTextContent('already re-opened')
    })

    it('offers no re-send for a campaign that never finished', async () => {
      routeFetch(defaultHandlers)

      render(<MarketingView jobTypes={jobTypes} />)

      await screen.findByText('August offer')
      expect(screen.queryByTestId('reopen-camp-1')).not.toBeInTheDocument()
    })
  })

  it('says so when a send finishes with every recipient failed', async () => {
    // The endpoint answers 200 for a send in which nothing was delivered, so an
    // HTTP-level check alone let a wholly failed campaign look like a successful click.
    routeFetch({
      'POST /api/campaigns/camp-1/send': jsonResponse({
        status: 'failed',
        hasMore: false,
        sent: 0,
        failed: 40,
        pending: 0,
        chunk: { processed: 40, sent: 0, failed: 40, deferred: 0, reason: null },
        failureReason: 'contact_id: This value should not be blank.',
      }),
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
    })

    render(<MarketingView jobTypes={jobTypes} />)
    fireEvent.click(await screen.findByTestId('send-camp-1'))
    const confirmButton = await screen.findByTestId('confirm-send')
    await waitFor(() => expect(confirmButton).not.toBeDisabled())
    fireEvent.click(confirmButton)

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/none of the 40 recipients were emailed/i)
    expect(banner).toHaveTextContent(/contact_id: This value should not be blank/)
  })

  it('reports a partial send with the count that got through', async () => {
    routeFetch({
      'POST /api/campaigns/camp-1/send': jsonResponse({
        status: 'failed',
        hasMore: false,
        sent: 12,
        failed: 3,
        pending: 0,
        chunk: { processed: 15, sent: 12, failed: 3, deferred: 0, reason: null },
        failureReason: 'Contact has no email address.',
      }),
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
    })

    render(<MarketingView jobTypes={jobTypes} />)
    fireEvent.click(await screen.findByTestId('send-camp-1'))
    const confirmButton = await screen.findByTestId('confirm-send')
    await waitFor(() => expect(confirmButton).not.toBeDisabled())
    fireEvent.click(confirmButton)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /sent to 12 of 15 recipients\. 3 failed/i
    )
  })

  it('stops and explains when the provider defers every request', async () => {
    // Every attempt came back retryable, so the rows stay pending and calling again
    // would spin until the guard tripped with a message about nothing in particular.
    let sendCalls = 0
    mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      const key = `${init?.method ?? 'GET'} ${url}`

      if (key.startsWith('GET /api/campaigns/camp-1/preflight')) {
        return jsonResponse({ total: 1, recipients: [] })
      }
      if (key === 'POST /api/campaigns/camp-1/send') {
        sendCalls += 1
        return jsonResponse({
          status: 'sending',
          hasMore: true,
          sent: 0,
          failed: 0,
          pending: 200,
          chunk: { processed: 200, sent: 0, failed: 0, deferred: 200, reason: 'Too many requests' },
          failureReason: null,
        })
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
    const confirmButton = await screen.findByTestId('confirm-send')
    await waitFor(() => expect(confirmButton).not.toBeDisabled())
    fireEvent.click(confirmButton)

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/Too many requests/)
    expect(banner).toHaveTextContent(/200 recipients still to go/i)
    // Stopped at the first stalled chunk instead of hammering the endpoint.
    expect(sendCalls).toBe(1)
  })

  it('keeps saying why a campaign failed after a reload', async () => {
    // A failure the operator can only see in the response to their own click is gone
    // the moment they refresh, leaving "failed" and nothing else.
    routeFetch({
      'GET /api/campaigns/camp-1/send': jsonResponse({
        total: 40,
        sent: 0,
        failed: 40,
        pending: 0,
        failureReason: 'Automation not found.',
        stallReason: null,
      }),
      ...defaultHandlers,
      'GET /api/campaigns': jsonResponse({
        campaigns: [
          {
            id: 'camp-1',
            name: 'August offer',
            status: 'failed',
            segment_id: 'seg-1',
            provider_automation_id: 'auto-1',
            segment: { name: 'NSW leads' },
          },
        ],
      }),
    })

    render(<MarketingView jobTypes={jobTypes} />)

    expect(await screen.findByTestId('send-report-camp-1')).toHaveTextContent(
      '40 of 40 recipients failed — Automation not found.'
    )
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
    const confirmButton = await screen.findByTestId('confirm-send')
    await waitFor(() => expect(confirmButton).not.toBeDisabled())
    fireEvent.click(confirmButton)

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
      fireEvent.change(screen.getByTestId('campaign-stream'), {
        target: { value: 'programs' },
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
          consentStream: 'programs',
        })
      })
    })

    it('asks for the stream when the automation is not a registered template', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      fireEvent.change(await screen.findByTestId('campaign-name'), {
        target: { value: 'August offer' },
      })

      // Nothing else says who a hand-typed automation is for, and guessing the
      // newsletter is how every campaign used to end up filed there.
      expect(screen.getByTestId('create-campaign')).toBeDisabled()

      fireEvent.change(screen.getByTestId('campaign-stream'), {
        target: { value: 'newsletter' },
      })
      expect(screen.getByTestId('create-campaign')).toBeEnabled()
    })

    it('takes the stream from a registered template instead of asking', async () => {
      routeFetch({
        ...defaultHandlers,
        'GET /api/templates': jsonResponse({
          templates: [
            {
              id: 't2',
              name: 'Course invite',
              description: null,
              provider_automation_id: 'course-auto',
              consent_stream: 'programs',
            },
          ],
        }),
      })

      render(<MarketingView jobTypes={jobTypes} />)

      fireEvent.change(await screen.findByTestId('campaign-name'), {
        target: { value: 'September courses' },
      })
      await screen.findByRole('option', { name: 'Course invite' })
      fireEvent.change(screen.getByTestId('campaign-automation-picker'), {
        target: { value: 'course-auto' },
      })

      expect(screen.queryByTestId('campaign-stream')).toBeNull()
      expect(screen.getByTestId('campaign-stream-inherited')).toHaveTextContent(
        'Courses & training'
      )

      fireEvent.click(screen.getByTestId('create-campaign'))

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(
          (entry) => entry[0] === '/api/campaigns' && entry[1]?.method === 'POST'
        )
        expect(JSON.parse(call![1].body)).toEqual({
          name: 'September courses',
          segmentId: null,
          templateId: 't2',
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
      fireEvent.change(screen.getByTestId('campaign-stream'), {
        target: { value: 'newsletter' },
      })
      fireEvent.click(screen.getByTestId('create-campaign'))

      expect(await screen.findByText('That name is taken.')).toBeInTheDocument()
    })
  })

  describe('streams in the campaign list', () => {
    it('labels each campaign with the stream it spends', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      expect(await screen.findByTestId('campaign-stream-camp-1')).toHaveTextContent('Newsletter')
    })

    it('narrows the list to one stream, starting again from the first page', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      fireEvent.change(await screen.findByTestId('campaign-stream-filter'), {
        target: { value: 'programs' },
      })

      await waitFor(() =>
        expect(
          mockFetch.mock.calls.some(
            ([url]) =>
              typeof url === 'string' &&
              url.startsWith('/api/campaigns?page=1&') &&
              url.includes('stream=programs')
          )
        ).toBe(true)
      )
    })
  })

  describe('awaiting approval', () => {
    it('narrows the list to campaigns waiting for approval', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      fireEvent.change(await screen.findByTestId('campaign-status-filter'), {
        target: { value: 'in_review' },
      })

      await waitFor(() =>
        expect(
          mockFetch.mock.calls.some(
            ([url]) => typeof url === 'string' && url.includes('status=in_review')
          )
        ).toBe(true)
      )
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

    it('returns a campaign under review to draft for corrections', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      fireEvent.click(await screen.findByTestId('draft-camp-1'))

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(
          (entry) => entry[0] === '/api/campaigns/camp-1' && entry[1]?.method === 'PATCH'
        )
        expect(JSON.parse(call![1].body)).toEqual({ status: 'draft' })
      })
    })

    it('retries only the failed recipients through the send endpoint', async () => {
      routeFetch({
        ...defaultHandlers,
        'GET /api/campaigns': jsonResponse({
          campaigns: [
            {
              id: 'camp-1',
              name: 'August offer',
              status: 'failed',
              segment_id: 'seg-1',
              provider_automation_id: 'auto-1',
              merge_fields: {},
              segment: { name: 'NSW leads' },
            },
          ],
        }),
        'POST /api/campaigns/camp-1/send': jsonResponse({
          status: 'sent',
          hasMore: false,
          failed: 0,
        }),
      })

      render(<MarketingView jobTypes={jobTypes} />)
      fireEvent.click(await screen.findByTestId('retry-camp-1'))

      // A retry sends email, so it goes through the same confirmation as a first send.
      const confirmButton = await screen.findByTestId('confirm-send')
      await waitFor(() => expect(confirmButton).toBeEnabled())
      expect(mockFetch).not.toHaveBeenCalledWith(
        '/api/campaigns/camp-1/send',
        expect.objectContaining({ method: 'POST' })
      )
      fireEvent.click(confirmButton)

      await waitFor(() =>
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/campaigns/camp-1/send',
          expect.objectContaining({ method: 'POST' })
        )
      )
    })

    it('edits segment and automation settings while the campaign is a draft', async () => {
      routeFetch({
        ...defaultHandlers,
        'GET /api/campaigns': jsonResponse({
          campaigns: [
            {
              id: 'camp-1',
              name: 'August offer',
              status: 'draft',
              segment_id: 'seg-1',
              provider_automation_id: '',
              merge_fields: {},
              segment: { name: 'NSW leads' },
            },
          ],
        }),
        'PATCH /api/campaigns/camp-1': jsonResponse({ campaign: {} }),
      })

      render(<MarketingView jobTypes={jobTypes} />)
      fireEvent.change(await screen.findByTestId('edit-automation-camp-1'), {
        target: { value: 'auto-9' },
      })
      fireEvent.click(screen.getByTestId('save-settings-camp-1'))

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(
          (entry) => entry[0] === '/api/campaigns/camp-1' && entry[1]?.method === 'PATCH'
        )
        expect(JSON.parse(call![1].body)).toEqual({
          segmentId: 'seg-1',
          providerAutomationId: 'auto-9',
        })
      })
    })
  })

  describe('an audience of nobody', () => {
    it('warns while building a segment that matches no one', async () => {
      routeFetch({
        ...defaultHandlers,
        'POST /api/segments/preview': jsonResponse({
          total: 0,
          truncated: false,
          estimatedSendMs: 0,
        }),
      })

      render(<MarketingView jobTypes={jobTypes} />)

      expect(await screen.findByTestId('segment-preview-empty')).toHaveTextContent(
        /cannot\s+generate copy or send/i
      )
    })

    it('counts the audience for the campaign whose copy is open', async () => {
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
              segment: { name: 'NSW leads' },
              merge_fields: {},
            },
          ],
        }),
        'POST /api/segments/preview': jsonResponse({
          total: 42,
          truncated: false,
          estimatedSendMs: 0,
        }),
      })

      render(<MarketingView jobTypes={jobTypes} />)

      fireEvent.click(await screen.findByTestId('review-copy-camp-1'))

      await waitFor(() =>
        expect(screen.getByTestId('composer-audience')).toHaveTextContent(
          'NSW leads · 42 contacts'
        )
      )
    })
  })

  describe('copy editor', () => {
    /** One campaign in the list, so the label under test is unambiguous. */
    function withCampaign(campaign: Record<string, unknown>) {
      routeFetch({
        ...defaultHandlers,
        'GET /api/campaigns': jsonResponse({
          campaigns: [
            {
              id: 'camp-1',
              name: 'August offer',
              segment_id: 'seg-1',
              provider_automation_id: 'auto-1',
              segment: { name: 'NSW leads' },
              ...campaign,
            },
          ],
        }),
      })
    }

    describe('its entry point names what is behind it', () => {
      // A button labelled just "Copy" reads as "duplicate this campaign". The AI
      // copywriter is the only way to fill a draft, and it lives behind this control,
      // so the label has to say so or the feature is undiscoverable.
      it('offers to write the copy when a draft has none', async () => {
        withCampaign({ status: 'draft', merge_fields: {} })
        render(<MarketingView jobTypes={jobTypes} />)

        expect(await screen.findByTestId('review-copy-camp-1')).toHaveTextContent(
          'Write copy with AI'
        )
      })

      it('offers to edit once a draft has copy', async () => {
        withCampaign({ status: 'draft', merge_fields: { subject: 'Book a review' } })
        render(<MarketingView jobTypes={jobTypes} />)

        expect(await screen.findByTestId('review-copy-camp-1')).toHaveTextContent(
          'Edit copy'
        )
      })

      it('offers to view copy that is past review and locked', async () => {
        withCampaign({ status: 'approved', merge_fields: { subject: 'Book a review' } })
        render(<MarketingView jobTypes={jobTypes} />)

        expect(await screen.findByTestId('review-copy-camp-1')).toHaveTextContent(
          'View copy'
        )
      })

      it('says hide while the panel is open', async () => {
        withCampaign({ status: 'draft', merge_fields: {} })
        render(<MarketingView jobTypes={jobTypes} />)

        fireEvent.click(await screen.findByTestId('review-copy-camp-1'))

        expect(screen.getByTestId('review-copy-camp-1')).toHaveTextContent('Hide copy')
      })

      it('ignores blank merge fields when deciding the label', async () => {
        withCampaign({ status: 'draft', merge_fields: { subject: '   ' } })
        render(<MarketingView jobTypes={jobTypes} />)

        expect(await screen.findByTestId('review-copy-camp-1')).toHaveTextContent(
          'Write copy with AI'
        )
      })
    })

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
  describe('email templates', () => {
    const templates = [
      {
        id: 't1',
        name: 'August free courses',
        description: null,
        provider_automation_id: 'auto-1',
      },
    ]

    it('offers registered templates by name when creating a campaign', async () => {
      // EmailOctopus cannot list its automations, so the picker can only be filled
      // from the registry.
      routeFetch({ ...defaultHandlers, 'GET /api/templates': jsonResponse({ templates }) })

      render(<MarketingView jobTypes={jobTypes} />)

      expect(
        await screen.findByRole('option', { name: 'August free courses' })
      ).toBeInTheDocument()
    })

    it('names the automation on a campaign row instead of showing a bare id', async () => {
      routeFetch({ ...defaultHandlers, 'GET /api/templates': jsonResponse({ templates }) })

      render(<MarketingView jobTypes={jobTypes} />)

      // Once on the campaign's meta line, and once as an option in each picker — the
      // meta line is the one that replaces a bare UUID with something readable.
      await waitFor(() =>
        expect(
          screen.getByText(/NSW leads · August free courses/)
        ).toBeInTheDocument()
      )
    })

    it('checks the automation ids of the whole page at once', async () => {
      render(<MarketingView jobTypes={jobTypes} />)

      await waitFor(() => {
        const call = mockFetch.mock.calls.find(
          (entry) => entry[0] === '/api/integrations/emailoctopus/automations'
        )
        expect(JSON.parse(call![1].body)).toEqual({ automationIds: ['auto-1'] })
      })
    })

    it('warns on a campaign whose automation EmailOctopus does not have', async () => {
      // The failure this catches: without it, the campaign looks fine until its send
      // fails for every recipient with the reason buried in the ledger.
      routeFetch({
        ...defaultHandlers,
        'POST /api/integrations/emailoctopus/automations': jsonResponse({
          results: { 'auto-1': { status: 'invalid', error: 'Journey not found.' } },
        }),
      })

      render(<MarketingView jobTypes={jobTypes} />)

      expect(await screen.findByTestId('automation-warning-camp-1')).toHaveTextContent(
        /Every recipient would fail/i
      )
    })

    it('does not warn when the check could not be completed', async () => {
      // A rate-limited or credential-less check says nothing about the id, and a row
      // that cried wolf would train an operator to ignore it.
      routeFetch({
        ...defaultHandlers,
        'POST /api/integrations/emailoctopus/automations': jsonResponse({
          results: { 'auto-1': { status: 'unknown', error: 'Slow down.' } },
        }),
      })

      render(<MarketingView jobTypes={jobTypes} />)

      await screen.findByText('August offer')
      expect(screen.queryByTestId('automation-warning-camp-1')).toBeNull()
    })
  })
})

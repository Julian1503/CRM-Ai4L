import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import EmailTemplateRegistry from './EmailTemplateRegistry'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

const TEMPLATE = {
  id: 't1',
  name: 'August free courses',
  description: 'Seasonal offer',
  provider_automation_id: 'auto-1',
  consent_stream: 'newsletter',
  archived_at: null,
}

/** Routes each request to a canned response, so tests state intent not call order. */
function routeFetch(handlers: Record<string, unknown>) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url}`

    for (const [pattern, response] of Object.entries(handlers).sort(
      ([left], [right]) => right.length - left.length
    )) {
      if (key.startsWith(pattern)) return response as ReturnType<typeof jsonResponse>
    }

    return jsonResponse({})
  })
}

const defaultHandlers = {
  'GET /api/templates': jsonResponse({ templates: [TEMPLATE] }),
  'POST /api/integrations/emailoctopus/automations': jsonResponse({
    results: { 'auto-1': { status: 'valid' } },
  }),
}

function bodyOf(call: [string, { body: string }]) {
  return JSON.parse(call[1].body)
}

function callTo(url: string, method: string) {
  return mockFetch.mock.calls.find(
    (entry) => entry[0] === url && (entry[1]?.method ?? 'GET') === method
  ) as [string, { body: string }] | undefined
}

describe('EmailTemplateRegistry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    routeFetch(defaultHandlers)
  })

  it('explains why names have to be recorded here at all', async () => {
    render(<EmailTemplateRegistry />)

    expect(
      await screen.findByText(/EmailOctopus offers no way to list automations/i)
    ).toBeInTheDocument()
  })

  it('lists registered templates with their automation id', async () => {
    render(<EmailTemplateRegistry />)

    expect(await screen.findByText('August free courses')).toBeInTheDocument()
    expect(screen.getByText(/auto-1/)).toBeInTheDocument()
  })

  it('checks every registered id on load and shows the verdict', async () => {
    render(<EmailTemplateRegistry />)

    await waitFor(() =>
      expect(bodyOf(callTo('/api/integrations/emailoctopus/automations', 'POST')!)).toEqual({
        automationIds: ['auto-1'],
      })
    )
    expect(await screen.findByTestId('template-status-t1')).toHaveTextContent(/Verified/i)
  })

  it('surfaces an id EmailOctopus no longer has, which is otherwise invisible', async () => {
    // The failure this whole screen exists for: an operator sees "Verified" or does
    // not, instead of finding out when a send fails for every recipient.
    routeFetch({
      ...defaultHandlers,
      'POST /api/integrations/emailoctopus/automations': jsonResponse({
        results: { 'auto-1': { status: 'invalid', error: 'Journey not found.' } },
      }),
    })

    render(<EmailTemplateRegistry />)

    expect(await screen.findByTestId('template-status-t1')).toHaveTextContent(
      /does not have an automation with this ID/i
    )
  })

  it('checks an id before it is registered', async () => {
    render(<EmailTemplateRegistry />)

    fireEvent.change(await screen.findByTestId('template-automation'), {
      target: { value: 'auto-9' },
    })
    fireEvent.click(screen.getByTestId('verify-template'))

    await waitFor(() =>
      expect(
        mockFetch.mock.calls.filter(
          (entry) => entry[0] === '/api/integrations/emailoctopus/automations'
        ).length
      ).toBe(2)
    )
  })

  it('registers a name against an id', async () => {
    render(<EmailTemplateRegistry />)

    fireEvent.change(await screen.findByTestId('template-name'), {
      target: { value: 'September intake' },
    })
    fireEvent.change(screen.getByTestId('template-description'), {
      target: { value: 'Second semester' },
    })
    fireEvent.change(screen.getByTestId('template-automation'), {
      target: { value: 'auto-9' },
    })
    fireEvent.change(screen.getByTestId('template-stream'), { target: { value: 'programs' } })
    fireEvent.click(screen.getByTestId('create-template'))

    await waitFor(() =>
      expect(bodyOf(callTo('/api/templates', 'POST')!)).toEqual({
        name: 'September intake',
        description: 'Second semester',
        providerAutomationId: 'auto-9',
        consentStream: 'programs',
      })
    )
  })

  it('will not register a name with no id, or an id with no name', async () => {
    render(<EmailTemplateRegistry />)

    const create = await screen.findByTestId('create-template')
    expect(create).toBeDisabled()

    fireEvent.change(screen.getByTestId('template-name'), { target: { value: 'Nameless' } })
    expect(create).toBeDisabled()

    fireEvent.change(screen.getByTestId('template-automation'), { target: { value: 'auto-9' } })
    // Still disabled: the stream is never pre-selected, because every campaign built on
    // the template inherits it and a default is a guess made on the operator's behalf.
    expect(create).toBeDisabled()

    fireEvent.change(screen.getByTestId('template-stream'), { target: { value: 'newsletter' } })
    expect(create).not.toBeDisabled()
  })

  it('shows which stream each template sends to', async () => {
    routeFetch({
      ...defaultHandlers,
      'GET /api/templates': jsonResponse({
        templates: [TEMPLATE, { ...TEMPLATE, id: 't2', name: 'Course invite', consent_stream: 'programs' }],
      }),
    })

    render(<EmailTemplateRegistry />)

    expect(await screen.findByTestId('template-stream-t1')).toHaveTextContent('Newsletter')
    expect(screen.getByTestId('template-stream-t2')).toHaveTextContent('Courses & training')
  })

  it('reports a duplicate name instead of silently doing nothing', async () => {
    routeFetch({
      ...defaultHandlers,
      'POST /api/templates': jsonResponse(
        { error: 'A template named "August free courses" already exists.' },
        false,
        409
      ),
    })

    render(<EmailTemplateRegistry />)

    fireEvent.change(await screen.findByTestId('template-name'), { target: { value: 'August' } })
    fireEvent.change(screen.getByTestId('template-automation'), { target: { value: 'a' } })
    fireEvent.change(screen.getByTestId('template-stream'), { target: { value: 'newsletter' } })
    fireEvent.click(screen.getByTestId('create-template'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/)
  })

  it('archives rather than deletes, because sent campaigns still reference it', async () => {
    render(<EmailTemplateRegistry />)

    fireEvent.click(await screen.findByTestId('template-t1-archive'))

    await waitFor(() =>
      expect(bodyOf(callTo('/api/templates/t1', 'PATCH')!)).toEqual({ archived: true })
    )
    expect(callTo('/api/templates/t1', 'DELETE')).toBeUndefined()
  })

  it('restores an archived template', async () => {
    routeFetch({
      ...defaultHandlers,
      'GET /api/templates': jsonResponse({
        templates: [{ ...TEMPLATE, archived_at: '2026-08-30T00:00:00Z' }],
      }),
    })

    render(<EmailTemplateRegistry />)

    fireEvent.click(await screen.findByTestId('template-t1-restore'))

    await waitFor(() =>
      expect(bodyOf(callTo('/api/templates/t1', 'PATCH')!)).toEqual({ archived: false })
    )
  })

  it('removes a template only after asking, and never with DELETE', async () => {
    render(<EmailTemplateRegistry />)

    fireEvent.click(await screen.findByTestId('template-t1-remove'))
    expect(callTo('/api/templates/t1', 'PATCH')).toBeUndefined()

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))

    await waitFor(() =>
      expect(bodyOf(callTo('/api/templates/t1', 'PATCH')!)).toEqual({ removed: true })
    )
    expect(callTo('/api/templates/t1', 'DELETE')).toBeUndefined()
  })

  it('does not spend a check on an archived template', async () => {
    routeFetch({
      ...defaultHandlers,
      'GET /api/templates': jsonResponse({
        templates: [{ ...TEMPLATE, archived_at: '2026-08-30T00:00:00Z' }],
      }),
    })

    render(<EmailTemplateRegistry />)

    await screen.findByText('August free courses')
    expect(callTo('/api/integrations/emailoctopus/automations', 'POST')).toBeUndefined()
  })

  it('reports a failed check as unknown, never as a wrong id', async () => {
    // Missing credentials would otherwise mark every registered template as broken.
    routeFetch({
      ...defaultHandlers,
      'POST /api/integrations/emailoctopus/automations': jsonResponse(
        { error: 'EmailOctopus credentials are not configured in Settings.' },
        false,
        409
      ),
    })

    render(<EmailTemplateRegistry />)

    const status = await screen.findByTestId('template-status-t1')
    expect(status).toHaveTextContent(/credentials are not configured/i)
    expect(status).not.toHaveTextContent(/does not have an automation/i)
  })

  it('says so when the templates cannot be loaded', async () => {
    routeFetch({
      ...defaultHandlers,
      'GET /api/templates': jsonResponse({ error: 'Database unavailable.' }, false, 500),
    })

    render(<EmailTemplateRegistry />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable.')
  })
})

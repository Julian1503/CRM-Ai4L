import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import NewsletterSchedules from './NewsletterSchedules'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

const SCHEDULE = {
  id: 's1',
  name: 'Monthly newsletter',
  template_id: 'tpl-news',
  segment_id: 'seg-1',
  frequency: 'monthly',
  next_run_at: '2026-10-31T21:00:00.000Z',
  timezone: 'Australia/Sydney',
  goal: 'Keep readers informed',
  tone: null,
  cta: null,
  must_include: null,
  avoid: null,
  is_active: true,
  archived_at: null,
}

const TEMPLATES = [
  { id: 'tpl-news', name: 'Newsletter layout', consent_stream: 'newsletter', provider_automation_id: 'a1' },
  { id: 'tpl-course', name: 'Course invite', consent_stream: 'programs', provider_automation_id: 'a2' },
]

function routeFetch(handlers: Record<string, unknown>) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url}`

    for (const [pattern, response] of Object.entries(handlers).sort(
      ([left], [right]) => right.length - left.length
    )) {
      if (key.startsWith(pattern)) return response
    }

    return jsonResponse({})
  })
}

const defaultHandlers = {
  'GET /api/newsletter-schedules': jsonResponse({ schedules: [SCHEDULE] }),
  'GET /api/templates': jsonResponse({ templates: TEMPLATES }),
  'GET /api/segments': jsonResponse({ segments: [{ id: 'seg-1', name: 'All subscribers' }] }),
  'GET /api/newsletter-schedules/s1/topics': jsonResponse({
    topics: [
      { id: 't1', title: 'AI note-taking', details: null, position: 1, used_at: null },
      { id: 't0', title: 'Welcome back', details: null, position: 0, used_at: '2026-09-01T00:00:00Z' },
    ],
  }),
}

function bodyOf(url: string, method: string) {
  const call = mockFetch.mock.calls.find((entry) => entry[0] === url && entry[1]?.method === method)
  return call ? JSON.parse(call[1].body) : undefined
}

describe('NewsletterSchedules', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    routeFetch(defaultHandlers)
  })

  it('says plainly that nothing is sent without approval', async () => {
    render(<NewsletterSchedules />)

    expect(await screen.findByText(/nothing is sent until someone approves/i)).toBeInTheDocument()
  })

  it('lists schedules with their frequency and next run', async () => {
    render(<NewsletterSchedules />)

    const row = await screen.findByTestId('schedule-s1')
    expect(row).toHaveTextContent('Monthly newsletter')
    expect(row).toHaveTextContent(/monthly/i)
    // 21:00 UTC on 31 Oct is 08:00 on 1 Nov in Sydney (AEDT).
    expect(within(row).getByTestId('schedule-next-s1')).toHaveTextContent(/1 Nov 2026/)
  })

  it('offers only newsletter templates', async () => {
    render(<NewsletterSchedules />)

    const picker = await screen.findByTestId('schedule-template')
    await waitFor(() =>
      expect(within(picker).getByRole('option', { name: 'Newsletter layout' })).toBeInTheDocument()
    )
    expect(within(picker).queryByRole('option', { name: 'Course invite' })).toBeNull()
  })

  it('creates a schedule from the brief', async () => {
    routeFetch({ ...defaultHandlers, 'POST /api/newsletter-schedules': jsonResponse({ schedule: SCHEDULE }) })
    render(<NewsletterSchedules />)

    await screen.findByRole('option', { name: 'Newsletter layout' })
    fireEvent.change(screen.getByTestId('schedule-name'), { target: { value: 'Weekly tips' } })
    fireEvent.change(screen.getByTestId('schedule-template'), { target: { value: 'tpl-news' } })
    fireEvent.change(screen.getByTestId('schedule-segment'), { target: { value: 'seg-1' } })
    fireEvent.change(screen.getByTestId('schedule-frequency'), { target: { value: 'weekly' } })
    fireEvent.change(screen.getByTestId('schedule-date'), { target: { value: '2026-10-05' } })
    fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '09:00' } })
    fireEvent.change(screen.getByTestId('schedule-goal'), { target: { value: 'One useful tip' } })
    fireEvent.change(screen.getByTestId('schedule-tone'), { target: { value: 'Friendly' } })
    fireEvent.click(screen.getByTestId('create-schedule'))

    await waitFor(() =>
      expect(bodyOf('/api/newsletter-schedules', 'POST')).toEqual({
        name: 'Weekly tips',
        templateId: 'tpl-news',
        segmentId: 'seg-1',
        frequency: 'weekly',
        firstRunDate: '2026-10-05',
        sendTime: '09:00',
        goal: 'One useful tip',
        tone: 'Friendly',
        cta: '',
        mustInclude: '',
        avoid: '',
      })
    )
  })

  it('will not create a schedule without a goal', async () => {
    render(<NewsletterSchedules />)

    await screen.findByRole('option', { name: 'Newsletter layout' })
    fireEvent.change(screen.getByTestId('schedule-name'), { target: { value: 'x' } })
    fireEvent.change(screen.getByTestId('schedule-template'), { target: { value: 'tpl-news' } })
    fireEvent.change(screen.getByTestId('schedule-segment'), { target: { value: 'seg-1' } })

    expect(screen.getByTestId('create-schedule')).toBeDisabled()
  })

  it('pauses a schedule', async () => {
    routeFetch({ ...defaultHandlers, 'PATCH /api/newsletter-schedules/s1': jsonResponse({ schedule: SCHEDULE }) })
    render(<NewsletterSchedules />)

    fireEvent.click(await screen.findByTestId('toggle-schedule-s1'))

    await waitFor(() =>
      expect(bodyOf('/api/newsletter-schedules/s1', 'PATCH')).toEqual({ isActive: false })
    )
  })

  it('drafts an issue on demand and says where to find it', async () => {
    routeFetch({
      ...defaultHandlers,
      'POST /api/newsletter-schedules/s1/run': jsonResponse({
        run: { scheduleId: 's1', status: 'in_review', campaignId: 'c1' },
      }),
    })
    render(<NewsletterSchedules />)

    fireEvent.click(await screen.findByTestId('run-schedule-s1'))

    expect(await screen.findByRole('status')).toHaveTextContent(/waiting for approval/i)
  })

  it('reports a run that could not write the copy', async () => {
    routeFetch({
      ...defaultHandlers,
      'POST /api/newsletter-schedules/s1/run': jsonResponse({
        run: { scheduleId: 's1', status: 'needs_attention', campaignId: 'c1' },
      }),
    })
    render(<NewsletterSchedules />)

    fireEvent.click(await screen.findByTestId('run-schedule-s1'))

    expect(await screen.findByRole('status')).toHaveTextContent(/could not be written/i)
  })

  it('surfaces a refused run', async () => {
    routeFetch({
      ...defaultHandlers,
      'POST /api/newsletter-schedules/s1/run': jsonResponse(
        { error: 'Today’s issue for this schedule already exists.' },
        false,
        409
      ),
    })
    render(<NewsletterSchedules />)

    fireEvent.click(await screen.findByTestId('run-schedule-s1'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/)
  })

  describe('topics', () => {
    it('shows the queue and what has been used', async () => {
      render(<NewsletterSchedules />)

      fireEvent.click(await screen.findByTestId('topics-schedule-s1'))

      expect(await screen.findByTestId('topic-t1')).toHaveTextContent('AI note-taking')
      expect(screen.getByTestId('topic-t0')).toHaveTextContent(/used/i)
      expect(screen.queryByTestId('remove-topic-t0')).toBeNull()
    })

    it('queues a new topic', async () => {
      routeFetch({
        ...defaultHandlers,
        'POST /api/newsletter-schedules/s1/topics': jsonResponse({ topic: { id: 't2' } }),
      })
      render(<NewsletterSchedules />)

      fireEvent.click(await screen.findByTestId('topics-schedule-s1'))
      fireEvent.change(await screen.findByTestId('topic-title'), {
        target: { value: 'Privacy basics' },
      })
      fireEvent.change(screen.getByTestId('topic-details'), { target: { value: 'Two tips' } })
      fireEvent.click(screen.getByTestId('add-topic'))

      await waitFor(() =>
        expect(bodyOf('/api/newsletter-schedules/s1/topics', 'POST')).toEqual({
          title: 'Privacy basics',
          details: 'Two tips',
        })
      )
    })

    it('removes a queued topic', async () => {
      routeFetch({
        ...defaultHandlers,
        'DELETE /api/newsletter-schedules/s1/topics/t1': jsonResponse({ deleted: 't1' }),
      })
      render(<NewsletterSchedules />)

      fireEvent.click(await screen.findByTestId('topics-schedule-s1'))
      fireEvent.click(await screen.findByTestId('remove-topic-t1'))

      await waitFor(() =>
        expect(
          mockFetch.mock.calls.some(
            ([url, init]) =>
              url === '/api/newsletter-schedules/s1/topics/t1' && init?.method === 'DELETE'
          )
        ).toBe(true)
      )
    })
  })
})

describe('NewsletterSchedules — occurrences that need attention (H12)', () => {
  const FAILED = {
    id: 'o1',
    schedule_id: 's1',
    scheduled_for: '2026-09-07',
    status: 'failed',
    attempts: 3,
    last_error: 'template_unusable',
    skip_reason: null,
  }
  const SKIPPED = {
    id: 'o2',
    schedule_id: 's1',
    scheduled_for: '2026-08-31',
    status: 'skipped',
    attempts: 0,
    last_error: null,
    skip_reason: 'Missed while the scheduler was not running.',
  }

  beforeEach(() => {
    jest.clearAllMocks()
    routeFetch({
      ...defaultHandlers,
      'GET /api/newsletter-schedules/occurrences': jsonResponse({ occurrences: [FAILED, SKIPPED] }),
    })
  })

  it('shows failed and skipped issues under their schedule with the reason', async () => {
    render(<NewsletterSchedules />)

    const failed = await screen.findByTestId('occurrence-o1')
    expect(failed).toHaveTextContent('Failed')
    expect(failed).toHaveTextContent('template_unusable (after 3 attempts)')
    expect(screen.getByTestId('occurrence-o2')).toHaveTextContent('Missed while the scheduler was not running.')
  })

  it.each([
    [{ status: 'in_review' }, /waiting for approval/],
    [{ status: 'needs_attention' }, /could not be written/],
    [{ status: 'skipped', reason: 'queued' }, /Queued again/],
    [{ status: 'skipped', reason: 'already_drafted' }, /already has a campaign/],
    [{ status: 'failed', reason: 'boom', occurrenceStatus: 'pending' }, /retried automatically/],
    [{ status: 'failed', reason: 'boom', occurrenceStatus: 'failed' }, /failed again: boom/],
  ])('retries an issue and reports %j', async (run, message) => {
    routeFetch({
      ...defaultHandlers,
      'GET /api/newsletter-schedules/occurrences': jsonResponse({ occurrences: [FAILED] }),
      'POST /api/newsletter-schedules/occurrences/o1/retry': jsonResponse({ run }),
    })
    render(<NewsletterSchedules />)

    fireEvent.click(await screen.findByTestId('retry-occurrence-o1'))

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledWith('/api/newsletter-schedules/occurrences/o1/retry', { method: 'POST' })
  })

  it('shows a refused retry', async () => {
    routeFetch({
      ...defaultHandlers,
      'GET /api/newsletter-schedules/occurrences': jsonResponse({ occurrences: [FAILED] }),
      'POST /api/newsletter-schedules/occurrences/o1/retry': jsonResponse(
        { error: 'Only a failed or skipped occurrence can be retried.' },
        false,
        409
      ),
    })
    render(<NewsletterSchedules />)

    fireEvent.click(await screen.findByTestId('retry-occurrence-o1'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Only a failed or skipped occurrence can be retried.')
  })
})

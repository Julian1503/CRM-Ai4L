/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

const mockGenerate = jest.fn()
const mockNotify = jest.fn()

jest.mock('@/lib/marketing/generateForCampaign', () => ({
  generateForCampaign: (...args: unknown[]) => mockGenerate(...args),
}))
jest.mock('./reviewEmail', () => ({
  sendReviewNotification: (...args: unknown[]) => mockNotify(...args),
}))

import { zonedToUtc } from './nextRun'
import { retryAndRunOccurrence, runDueSchedules, runScheduleNow } from './runDue'

const NOW = zonedToUtc('2026-10-01', '08:05', 'Australia/Sydney')
const DUE = zonedToUtc('2026-10-01', '08:00', 'Australia/Sydney').toISOString()

const SCHEDULE = {
  id: 'sched-1',
  name: 'Monthly newsletter',
  template_id: 'tpl-1',
  segment_id: 'seg-1',
  frequency: 'monthly',
  next_run_at: DUE,
  timezone: 'Australia/Sydney',
  goal: 'Keep readers informed',
  tone: 'Warm',
  cta: 'Book a call',
  must_include: null,
  avoid: null,
  is_active: true,
  archived_at: null,
}

const OCCURRENCE = {
  id: 'occ-1',
  schedule_id: 'sched-1',
  scheduled_for: '2026-10-01',
  due_at: DUE,
  status: 'drafting',
  attempts: 1,
  max_attempts: 3,
  claim_token: 'token-1',
}

const TEMPLATE = {
  id: 'tpl-1',
  provider_automation_id: 'auto-news',
  consent_stream: 'newsletter',
  archived_at: null,
}

const TOPIC = { id: 'topic-1', title: 'AI note-taking', details: 'Privacy settings' }

type Tables = {
  schedules: QueryBuilderMock
  templates: QueryBuilderMock
  campaigns: QueryBuilderMock
  topics: QueryBuilderMock
}

type Rpc = Record<string, unknown>

function setup(overrides: Partial<Record<keyof Tables, unknown[]>> & { rpc?: Rpc } = {}) {
  const tables: Tables = {
    schedules: createQueryBuilderMock(
      overrides.schedules ?? [
        { data: [SCHEDULE], error: null },
        { data: SCHEDULE, error: null },
      ]
    ),
    templates: createQueryBuilderMock(overrides.templates ?? [{ data: TEMPLATE, error: null }]),
    campaigns: createQueryBuilderMock(
      overrides.campaigns ?? [
        { data: { id: 'camp-1', name: 'Monthly newsletter — 2026-10-01' }, error: null },
        { data: [{ subject: 'Last month' }], error: null },
        { data: { id: 'camp-1' }, error: null },
      ]
    ),
    topics: createQueryBuilderMock(
      overrides.topics ?? [
        { data: null, error: null },
        { data: TOPIC, error: null },
        { data: null, error: null },
      ]
    ),
  }

  const byName: Record<string, QueryBuilderMock> = {
    newsletter_schedules: tables.schedules,
    campaign_templates: tables.templates,
    campaigns: tables.campaigns,
    newsletter_topics: tables.topics,
  }

  const rpcResults: Rpc = {
    record_newsletter_occurrences: { data: { outcome: 'recorded', pendingId: 'occ-1', skipped: 0 }, error: null },
    claim_newsletter_occurrences: { data: [OCCURRENCE], error: null },
    complete_newsletter_occurrence: { data: true, error: null },
    fail_newsletter_occurrence: { data: 'pending', error: null },
    retry_newsletter_occurrence: { data: { ...OCCURRENCE, status: 'pending' }, error: null },
    ...overrides.rpc,
  }

  const db = createDbMock((table: string) => byName[table])
  db.rpc.mockImplementation(async (fn: string) => rpcResults[fn])

  return { db, tables }
}

const rpcCalls = (db: { rpc: jest.Mock }, fn: string) =>
  db.rpc.mock.calls.filter((call) => call[0] === fn).map((call) => call[1] as Record<string, unknown>)

const messages = { create: jest.fn() }

function run(db: unknown, options: { messages?: unknown } = {}) {
  return runDueSchedules({
    db: db as never,
    messages: ('messages' in options ? options.messages : messages) as never,
    now: NOW,
  })
}

function resetMocks() {
  jest.clearAllMocks()
  mockGenerate.mockResolvedValue({
    ok: true,
    campaign: { id: 'camp-1', subject: 'AI note-taking, safely' },
    generation: { attempts: 1, usage: { inputTokens: 1, outputTokens: 1 } },
    audience: { size: 10, truncated: false },
  })
  mockNotify.mockResolvedValue({ status: 'sent', recipients: 1 })
}

describe('runDueSchedules — recording (H12)', () => {
  beforeEach(resetMocks)

  it('reads only active, unarchived schedules that are due', async () => {
    const { db, tables } = setup()

    await run(db)

    const eqs = tables.schedules.allFor('eq').map((call) => call.args)
    expect(eqs).toContainEqual(['is_active', true])
    expect(tables.schedules.argsFor('is')).toEqual(['archived_at', null])
    expect(tables.schedules.argsFor('lte')).toEqual(['next_run_at', NOW.toISOString()])
  })

  it('records the occurrence and the next run in one database call, never by a separate update', async () => {
    const { db, tables } = setup()

    await run(db)

    expect(rpcCalls(db, 'record_newsletter_occurrences')).toEqual([
      {
        p_schedule_id: 'sched-1',
        p_expected_next_run_at: DUE,
        p_next_run_at: zonedToUtc('2026-11-01', '08:00', 'Australia/Sydney').toISOString(),
        p_occurrences: [{ scheduledFor: '2026-10-01', dueAt: DUE }],
      },
    ])
    expect(tables.schedules.argsFor('update')).toBeUndefined()
  })

  it('reports a schedule whose occurrence could not be recorded, and still drafts claimed work', async () => {
    const { db } = setup({ rpc: { record_newsletter_occurrences: { data: null, error: { message: 'deadlock' } } } })
    jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const reports = await run(db)

    expect(reports[0]).toMatchObject({ scheduleId: 'sched-1', status: 'failed' })
    expect(reports[0].reason).toMatch(/deadlock/)
    expect(reports[1]).toMatchObject({ occurrenceId: 'occ-1', status: 'in_review' })
  })

  it('claims a few occurrences per run with a lease', async () => {
    const { db } = setup()

    await run(db)

    expect(rpcCalls(db, 'claim_newsletter_occurrences')).toEqual([
      { p_limit: 3, p_lease_seconds: 300, p_occurrence_id: null },
    ])
  })

  it('drafts nothing when no occurrence can be claimed (another run holds it)', async () => {
    const { db, tables } = setup({ rpc: { claim_newsletter_occurrences: { data: [], error: null } } })

    expect(await run(db)).toEqual([])
    expect(tables.campaigns.argsFor('insert')).toBeUndefined()
  })

  it('fails the run when claiming itself fails', async () => {
    const { db } = setup({ rpc: { claim_newsletter_occurrences: { data: null, error: { message: 'down' } } } })
    await expect(run(db)).rejects.toThrow(/claim newsletter occurrences/)
  })
})

describe('runDueSchedules — drafting a claimed occurrence', () => {
  beforeEach(resetMocks)

  it('drafts a newsletter campaign for the occurrence and records it drafted', async () => {
    const { db, tables } = setup()

    const [report] = await run(db)

    expect((tables.campaigns.argsFor('insert') as [Record<string, unknown>])[0]).toMatchObject({
      name: 'Monthly newsletter — 2026-10-01',
      segment_id: 'seg-1',
      template_id: 'tpl-1',
      provider_automation_id: 'auto-news',
      consent_stream: 'newsletter',
      schedule_id: 'sched-1',
      scheduled_for: '2026-10-01',
    })
    expect(report).toMatchObject({ scheduleId: 'sched-1', occurrenceId: 'occ-1', status: 'in_review', campaignId: 'camp-1' })
    expect(rpcCalls(db, 'complete_newsletter_occurrence')).toEqual([
      { p_occurrence_id: 'occ-1', p_claim_token: 'token-1', p_campaign_id: 'camp-1' },
    ])
  })

  it('writes the copy from the schedule brief, the next topic and recent subjects', async () => {
    const { db } = setup()

    await run(db)

    expect(mockGenerate).toHaveBeenCalledWith(db, messages, 'camp-1', {
      goal: 'Keep readers informed',
      tone: 'Warm',
      cta: 'Book a call',
      mustInclude: null,
      avoid: null,
      topic: { title: 'AI note-taking', details: 'Privacy settings' },
      recentSubjects: ['Last month'],
    })
  })

  it('marks the topic used and moves the campaign into review', async () => {
    const { db, tables } = setup()

    await run(db)

    expect((tables.topics.argsFor('update') as [Record<string, unknown>])[0]).toMatchObject({ campaign_id: 'camp-1' })
    expect(tables.campaigns.allFor('update').map((call) => call.args[0])).toContainEqual({ status: 'in_review' })
  })

  it('tells the reviewers', async () => {
    const { db } = setup()

    await run(db)

    expect(mockNotify).toHaveBeenCalledWith({
      scheduleName: 'Monthly newsletter',
      campaignId: 'camp-1',
      campaignName: 'Monthly newsletter — 2026-10-01',
      subject: 'AI note-taking, safely',
      scheduledFor: '2026-10-01',
      topicTitle: 'AI note-taking',
      generationError: null,
    })
  })

  it('still drafts from the goal alone when the topic queue is empty', async () => {
    const { db, tables } = setup({ topics: [{ data: null, error: null }] })

    await run(db)

    expect(mockGenerate.mock.calls[0][3]).toMatchObject({ topic: null })
    expect(tables.topics.argsFor('update')).toBeUndefined()
  })

  it('resumes a draft an earlier attempt created, keeping the topic it already took', async () => {
    const { db, tables } = setup({
      campaigns: [
        { data: null, error: { code: '23505', message: 'duplicate key' } },
        { data: { id: 'camp-1', name: 'Monthly newsletter — 2026-10-01', status: 'draft' }, error: null },
        { data: [], error: null },
        { data: { id: 'camp-1' }, error: null },
      ],
      topics: [{ data: TOPIC, error: null }, { data: null, error: null }],
    })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'in_review', campaignId: 'camp-1' })
    expect(tables.topics.allFor('eq').map((call) => call.args)).toContainEqual(['campaign_id', 'camp-1'])
    expect(mockGenerate.mock.calls[0][3]).toMatchObject({ topic: { title: 'AI note-taking' } })
    expect(rpcCalls(db, 'complete_newsletter_occurrence')).toHaveLength(1)
  })

  it('records an occurrence whose campaign is already past draft as drafted, without redoing it', async () => {
    const { db } = setup({
      campaigns: [
        { data: null, error: { code: '23505', message: 'duplicate key' } },
        { data: { id: 'camp-9', name: 'x', status: 'in_review' }, error: null },
      ],
    })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'skipped', reason: 'already_drafted', campaignId: 'camp-9' })
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(rpcCalls(db, 'complete_newsletter_occurrence')[0]).toMatchObject({ p_campaign_id: 'camp-9' })
  })

  it('fails (not retryable) on an archived segment, by name', async () => {
    const { db } = setup({
      campaigns: [{ data: null, error: { code: 'CRM01', message: 'Segment is archived.' } }],
      rpc: { fail_newsletter_occurrence: { data: 'failed', error: null } },
    })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'failed', reason: 'segment_archived', occurrenceStatus: 'failed' })
    expect(rpcCalls(db, 'fail_newsletter_occurrence')[0]).toMatchObject({ p_error: 'segment_archived', p_retryable: false })
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it.each([
    ['archived', { ...TEMPLATE, archived_at: '2026-09-01T00:00:00Z' }],
    ['a courses template', { ...TEMPLATE, consent_stream: 'programs' }],
    ['without an automation', { ...TEMPLATE, provider_automation_id: null }],
    ['a Content Studio template', { ...TEMPLATE, contract_id: 'studio-static-v1', contract_version: 1 }],
  ])('refuses to draft on a template that is %s', async (_label, template) => {
    const { db, tables } = setup({ templates: [{ data: template, error: null }] })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'failed', reason: 'template_unusable' })
    expect(rpcCalls(db, 'fail_newsletter_occurrence')[0]).toMatchObject({ p_retryable: false })
    expect(tables.campaigns.argsFor('insert')).toBeUndefined()
  })

  it('returns an occurrence to the queue when a step fails after the claim (no lost issue)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db } = setup({ templates: [{ data: null, error: { message: 'connection reset' } }] })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'failed', occurrenceStatus: 'pending' })
    expect(rpcCalls(db, 'fail_newsletter_occurrence')[0]).toMatchObject({
      p_occurrence_id: 'occ-1',
      p_claim_token: 'token-1',
      p_retryable: true,
    })
    expect(rpcCalls(db, 'complete_newsletter_occurrence')).toHaveLength(0)
  })

  it('reports a failure it could not record; the lease will make it retryable', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db } = setup({
      templates: [{ data: null, error: { message: 'boom' } }],
      rpc: { fail_newsletter_occurrence: { data: null, error: { message: 'also down' } } },
    })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'failed', occurrenceStatus: undefined })
  })

  it('fails (not retryable) when the schedule row is gone', async () => {
    const { db } = setup({ schedules: [{ data: [], error: null }, { data: null, error: null }] })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'failed', reason: 'schedule_missing' })
  })

  it('reports a lost lease instead of claiming the occurrence was recorded', async () => {
    const { db } = setup({ rpc: { complete_newsletter_occurrence: { data: false, error: null } } })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'in_review', occurrenceStatus: 'lost' })
  })

  it('leaves a draft that needs attention when the copy cannot be written', async () => {
    mockGenerate.mockRejectedValue(new Error('The model declined.'))
    const { db, tables } = setup()

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'needs_attention', campaignId: 'camp-1' })
    const updates = tables.campaigns.allFor('update').map((call) => call.args[0])
    expect(updates).not.toContainEqual({ status: 'in_review' })
    expect(updates).toContainEqual({ notes: 'Automatic copy generation failed: The model declined.' })
    expect(tables.topics.argsFor('update')).toBeUndefined()
    expect(mockNotify.mock.calls[0][0]).toMatchObject({ generationError: 'The model declined.' })
  })

  it('reports a missing API key as needing attention instead of failing silently', async () => {
    const { db } = setup()

    const [report] = await run(db, { messages: null })

    expect(report).toMatchObject({ status: 'needs_attention' })
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockNotify.mock.calls[0][0].generationError).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('keeps the draft when the notification cannot be delivered', async () => {
    mockNotify.mockRejectedValue(new Error('Resend is down'))
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db } = setup()

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'in_review', notification: 'failed' })
  })

  it('carries on to the next occurrence when one fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const second = { ...OCCURRENCE, id: 'occ-2', scheduled_for: '2026-10-08' }
    const { db } = setup({
      schedules: [
        { data: [], error: null },
        { data: SCHEDULE, error: null },
        { data: SCHEDULE, error: null },
      ],
      templates: [
        { data: null, error: { message: 'boom' } },
        { data: TEMPLATE, error: null },
      ],
      rpc: { claim_newsletter_occurrences: { data: [OCCURRENCE, second], error: null } },
    })

    const reports = await run(db)

    expect(reports.map((report) => report.status)).toEqual(['failed', 'in_review'])
  })
})

describe('retryAndRunOccurrence', () => {
  beforeEach(resetMocks)

  it('puts the occurrence back in the queue, claims exactly it, and drafts it now', async () => {
    const { db } = setup({ schedules: [{ data: SCHEDULE, error: null }] })

    const report = await retryAndRunOccurrence({ db: db as never, messages: messages as never, now: NOW }, 'occ-1')

    expect(rpcCalls(db, 'retry_newsletter_occurrence')).toEqual([{ p_occurrence_id: 'occ-1' }])
    expect(rpcCalls(db, 'claim_newsletter_occurrences')).toEqual([
      { p_limit: 1, p_lease_seconds: 300, p_occurrence_id: 'occ-1' },
    ])
    expect(report).toMatchObject({ occurrenceId: 'occ-1', status: 'in_review' })
  })

  it('reports it queued when it cannot be claimed now (paused schedule)', async () => {
    const { db } = setup({ rpc: { claim_newsletter_occurrences: { data: [], error: null } } })

    const report = await retryAndRunOccurrence({ db: db as never, messages: messages as never, now: NOW }, 'occ-1')

    expect(report).toMatchObject({ status: 'skipped', reason: 'queued', scheduledFor: '2026-10-01' })
  })

  it.each([
    [{ code: 'P0002', message: 'Occurrence not found.' }, 404],
    [{ code: 'CRM06', message: 'Only a failed or skipped occurrence can be retried.' }, 409],
  ])('maps a refused retry %j to %s', async (error, status) => {
    const { db } = setup({ rpc: { retry_newsletter_occurrence: { data: null, error } } })

    await expect(
      retryAndRunOccurrence({ db: db as never, messages: messages as never, now: NOW }, 'occ-1')
    ).rejects.toMatchObject({ status })
  })
})

describe('runScheduleNow', () => {
  beforeEach(() => {
    resetMocks()
    mockNotify.mockResolvedValue({ status: 'skipped', reason: 'not_configured' })
  })

  it('drafts today’s issue without moving the schedule or recording an occurrence', async () => {
    const { db, tables } = setup()

    const report = await runScheduleNow({ db: db as never, messages: messages as never, now: NOW }, SCHEDULE as never)

    expect(report).toMatchObject({ status: 'in_review', notification: 'skipped' })
    expect(tables.schedules.argsFor('update')).toBeUndefined()
    expect(db.rpc).not.toHaveBeenCalled()
    expect((tables.campaigns.argsFor('insert') as [Record<string, unknown>])[0]).toMatchObject({ scheduled_for: '2026-10-01' })
  })

  it('finds the existing draft instead of making a second or rewriting it', async () => {
    const { db } = setup({
      campaigns: [
        { data: null, error: { code: '23505', message: 'duplicate key' } },
        { data: { id: 'camp-1', name: 'x', status: 'draft' }, error: null },
      ],
    })

    const report = await runScheduleNow({ db: db as never, messages: messages as never, now: NOW }, SCHEDULE as never)

    expect(report).toMatchObject({ status: 'skipped', reason: 'already_drafted' })
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('reports an unusable template', async () => {
    const { db } = setup({ templates: [{ data: { ...TEMPLATE, archived_at: 'x' }, error: null }] })
    const report = await runScheduleNow({ db: db as never, messages: messages as never, now: NOW }, SCHEDULE as never)
    expect(report).toMatchObject({ status: 'failed', reason: 'template_unusable' })
  })

  it('reports an unexpected error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db } = setup({ templates: [{ data: null, error: { message: 'boom' } }] })
    const report = await runScheduleNow({ db: db as never, messages: messages as never, now: NOW }, SCHEDULE as never)
    expect(report).toMatchObject({ status: 'failed' })
    expect(report.reason).toMatch(/boom/)
  })
})

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
import { runDueSchedules, runScheduleNow } from './runDue'

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

function setup(overrides: Partial<Record<keyof Tables, unknown[]>> = {}) {
  const tables: Tables = {
    schedules: createQueryBuilderMock(
      overrides.schedules ?? [
        { data: [SCHEDULE], error: null },
        { data: [{ id: 'sched-1' }], error: null },
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

  const db = createDbMock((table: string) => byName[table])

  return { db, tables }
}

const messages = { create: jest.fn() }

function run(db: unknown, options: { messages?: unknown } = {}) {
  return runDueSchedules({
    db: db as never,
    messages: ('messages' in options ? options.messages : messages) as never,
    now: NOW,
  })
}

describe('runDueSchedules', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGenerate.mockResolvedValue({
      ok: true,
      campaign: { id: 'camp-1', subject: 'AI note-taking, safely' },
      generation: { attempts: 1, usage: { inputTokens: 1, outputTokens: 1 } },
      audience: { size: 10, truncated: false },
    })
    mockNotify.mockResolvedValue({ status: 'sent', recipients: 1 })
  })

  it('reads only active, unarchived schedules that are due, a few at a time', async () => {
    const { db, tables } = setup()

    await run(db)

    const eqs = tables.schedules.allFor('eq').map((call) => call.args)
    expect(eqs).toContainEqual(['is_active', true])
    expect(tables.schedules.argsFor('is')).toEqual(['archived_at', null])
    expect(tables.schedules.argsFor('lte')).toEqual(['next_run_at', NOW.toISOString()])
    expect(tables.schedules.argsFor('limit')).toEqual([3])
  })

  it('claims the occurrence by advancing next_run_at only if nobody else has', async () => {
    const { db, tables } = setup()

    await run(db)

    const update = tables.schedules.argsFor('update') as [Record<string, unknown>]
    expect(update[0].next_run_at).toBe(zonedToUtc('2026-11-01', '08:00', 'Australia/Sydney').toISOString())
    // The optimistic lock: a concurrent run that already advanced it matches nothing.
    expect(tables.schedules.allFor('eq').map((call) => call.args)).toContainEqual([
      'next_run_at',
      DUE,
    ])
  })

  it('drafts a newsletter campaign for the occurrence from the template', async () => {
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
    expect(report).toMatchObject({ scheduleId: 'sched-1', status: 'in_review', campaignId: 'camp-1' })
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

    expect((tables.topics.argsFor('update') as [Record<string, unknown>])[0]).toMatchObject({
      campaign_id: 'camp-1',
    })
    expect(tables.campaigns.allFor('update').map((call) => call.args[0])).toContainEqual({
      status: 'in_review',
    })
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

  it('does nothing when another run claimed the occurrence first', async () => {
    const { db, tables } = setup({
      schedules: [
        { data: [SCHEDULE], error: null },
        { data: [], error: null },
      ],
    })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'skipped', reason: 'claimed_elsewhere' })
    expect(tables.campaigns.argsFor('insert')).toBeUndefined()
  })

  it('treats an occurrence that already has a campaign as done', async () => {
    const { db } = setup({
      campaigns: [{ data: null, error: { code: '23505', message: 'duplicate key' } }],
    })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'skipped', reason: 'already_drafted' })
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it.each([
    ['archived', { ...TEMPLATE, archived_at: '2026-09-01T00:00:00Z' }],
    ['a courses template', { ...TEMPLATE, consent_stream: 'programs' }],
    ['without an automation', { ...TEMPLATE, provider_automation_id: null }],
  ])('refuses to draft on a template that is %s', async (_label, template) => {
    const { db, tables } = setup({ templates: [{ data: template, error: null }] })

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'failed', reason: 'template_unusable' })
    expect(tables.campaigns.argsFor('insert')).toBeUndefined()
  })

  it('leaves a draft that needs attention when the copy cannot be written', async () => {
    mockGenerate.mockRejectedValue(new Error('The model declined.'))
    const { db, tables } = setup()

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'needs_attention', campaignId: 'camp-1' })
    const updates = tables.campaigns.allFor('update').map((call) => call.args[0])
    expect(updates).not.toContainEqual({ status: 'in_review' })
    expect(updates).toContainEqual({
      notes: 'Automatic copy generation failed: The model declined.',
    })
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
    const { db } = setup()

    const [report] = await run(db)

    expect(report).toMatchObject({ status: 'in_review', notification: 'failed' })
  })

  it('carries on to the next schedule when one fails', async () => {
    const second = { ...SCHEDULE, id: 'sched-2', name: 'Weekly' }
    const { db } = setup({
      schedules: [
        { data: [SCHEDULE, second], error: null },
        { data: [{ id: 'sched-1' }], error: null },
        { data: [{ id: 'sched-2' }], error: null },
      ],
      templates: [
        { data: null, error: { message: 'boom' } },
        { data: TEMPLATE, error: null },
      ],
    })

    const reports = await run(db)

    expect(reports.map((report) => report.status)).toEqual(['failed', 'in_review'])
  })
})

describe('runScheduleNow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGenerate.mockResolvedValue({
      ok: true,
      campaign: { id: 'camp-1', subject: 'Today' },
      generation: { attempts: 1, usage: { inputTokens: 1, outputTokens: 1 } },
      audience: { size: 10, truncated: false },
    })
    mockNotify.mockResolvedValue({ status: 'skipped', reason: 'not_configured' })
  })

  it('drafts today’s issue without moving the schedule', async () => {
    const { db, tables } = setup()

    const report = await runScheduleNow(
      { db: db as never, messages: messages as never, now: NOW },
      SCHEDULE as never
    )

    expect(report).toMatchObject({ status: 'in_review', notification: 'skipped' })
    // "Generate now" is an extra issue, not the scheduled one: the next run stays put.
    expect(tables.schedules.argsFor('update')).toBeUndefined()
    expect((tables.campaigns.argsFor('insert') as [Record<string, unknown>])[0]).toMatchObject({
      scheduled_for: '2026-10-01',
    })
  })
})


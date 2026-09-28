import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { campaignLifecycle, findSegmentUsers, segmentLifecycle } from './entityLifecycle'

const LIVE = { archived_at: null, removed_at: null }
const ARCHIVED = { archived_at: '2026-09-01T00:00:00.000Z', removed_at: null }
const REMOVED = { archived_at: '2026-09-01T00:00:00.000Z', removed_at: '2026-09-02T00:00:00.000Z' }

describe('segmentLifecycle', () => {
  it('lets an unused live segment be archived or removed', () => {
    expect(segmentLifecycle(LIVE, [])).toEqual({
      canArchive: true,
      canRestore: false,
      canRemove: true,
      reason: null,
    })
  })

  it('blocks a segment in use, naming what uses it', () => {
    const lifecycle = segmentLifecycle(LIVE, [
      { kind: 'campaign', name: 'August offer' },
      { kind: 'schedule', name: 'Monthly' },
    ])

    expect(lifecycle).toMatchObject({ canArchive: false, canRemove: false })
    expect(lifecycle.reason).toContain('campaign "August offer"')
    expect(lifecycle.reason).toContain('newsletter schedule "Monthly"')
  })

  it('lets an archived segment be restored or removed', () => {
    expect(segmentLifecycle(ARCHIVED, [])).toEqual({
      canArchive: false,
      canRestore: true,
      canRemove: true,
      reason: null,
    })
  })

  it('offers nothing for a removed segment', () => {
    expect(segmentLifecycle(REMOVED, [])).toMatchObject({
      canArchive: false,
      canRestore: false,
      canRemove: false,
    })
  })
})

describe('campaignLifecycle', () => {
  it.each(['draft', 'in_review', 'failed', 'sent'] as const)('lets a %s campaign be archived or removed', (status) => {
    expect(campaignLifecycle({ status, ...LIVE })).toMatchObject({ canArchive: true, canRemove: true })
  })

  it.each(['approved', 'sending'] as const)('blocks a %s campaign, because mail may be leaving', (status) => {
    const lifecycle = campaignLifecycle({ status, ...LIVE })

    expect(lifecycle).toMatchObject({ canArchive: false, canRemove: false })
    expect(lifecycle.reason).toContain(status)
  })

  it('lets an archived campaign be restored or removed', () => {
    expect(campaignLifecycle({ status: 'draft', ...ARCHIVED })).toMatchObject({
      canArchive: false,
      canRestore: true,
      canRemove: true,
    })
  })

  it('offers nothing for a removed campaign', () => {
    expect(campaignLifecycle({ status: 'sent', ...REMOVED })).toMatchObject({
      canArchive: false,
      canRestore: false,
      canRemove: false,
    })
  })
})

describe('findSegmentUsers', () => {
  it('lists unfinished live campaigns and live schedules', async () => {
    const campaigns = createQueryBuilderMock({ data: [{ name: 'August offer' }], error: null })
    const schedules = createQueryBuilderMock({ data: [{ name: 'Monthly' }], error: null })
    const db = createDbMock((table: string) => (table === 'campaigns' ? campaigns : schedules))

    await expect(findSegmentUsers(db as never, 'seg-1')).resolves.toEqual([
      { kind: 'campaign', name: 'August offer' },
      { kind: 'schedule', name: 'Monthly' },
    ])

    expect(campaigns.calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['segment_id', 'seg-1'] },
        { method: 'is', args: ['archived_at', null] },
        { method: 'neq', args: ['status', 'sent'] },
      ])
    )
    expect(schedules.calls).toEqual(expect.arrayContaining([{ method: 'is', args: ['archived_at', null] }]))
  })

  it('surfaces a failed lookup', async () => {
    const failing = createQueryBuilderMock({ data: null, error: { message: 'boom' } })
    const db = createDbMock(() => failing)

    await expect(findSegmentUsers(db as never, 'seg-1')).rejects.toThrow('boom')
  })
})

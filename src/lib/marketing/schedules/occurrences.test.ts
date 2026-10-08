/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { zonedToUtc } from './nextRun'
import {
  claimOccurrences,
  completeOccurrence,
  dueOccurrences,
  failOccurrence,
  listAttentionOccurrences,
  MAX_RECORDED_OCCURRENCES,
  OccurrenceRetryError,
  recordDueOccurrences,
  retryOccurrence,
} from './occurrences'

const TZ = 'Australia/Sydney'
const DUE = zonedToUtc('2026-09-07', '08:00', TZ)

function dbWithRpc(result: unknown) {
  const db = createDbMock(createQueryBuilderMock())
  db.rpc.mockResolvedValue(result)
  return db
}

describe('dueOccurrences', () => {
  it('lists every occurrence up to now in local dates and the first one after', () => {
    const now = zonedToUtc('2026-09-22', '09:00', TZ)

    const due = dueOccurrences(DUE, 'weekly', TZ, now)

    expect(due.occurrences.map((occurrence) => occurrence.scheduledFor)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21'])
    expect(due.occurrences[0].dueAt).toBe(DUE.toISOString())
    expect(due.nextRunAt.toISOString()).toBe(zonedToUtc('2026-09-28', '08:00', TZ).toISOString())
  })

  it('keeps the same local time across daylight saving', () => {
    // Sydney moves to daylight time on 2026-10-04.
    const due = dueOccurrences(zonedToUtc('2026-10-01', '08:00', TZ), 'weekly', TZ, zonedToUtc('2026-10-08', '09:00', TZ))
    expect(due.occurrences.map((occurrence) => occurrence.dueAt)).toEqual([
      zonedToUtc('2026-10-01', '08:00', TZ).toISOString(),
      zonedToUtc('2026-10-08', '08:00', TZ).toISOString(),
    ])
  })

  it('returns nothing due before the first occurrence', () => {
    expect(dueOccurrences(DUE, 'monthly', TZ, new Date(DUE.getTime() - 1)).occurrences).toEqual([])
  })

  it('bounds a very long outage to the first and the most recent occurrences', () => {
    const due = dueOccurrences(DUE, 'weekly', TZ, new Date(DUE.getTime() + 300 * 7 * 24 * 60 * 60 * 1000))
    expect(due.occurrences).toHaveLength(MAX_RECORDED_OCCURRENCES)
    expect(due.occurrences[0].dueAt).toBe(DUE.toISOString())
  })
})

describe('RPC wrappers', () => {
  const SCHEDULE = { id: 's1', next_run_at: DUE.toISOString(), frequency: 'weekly' as const, timezone: TZ }

  it('records nothing when no occurrence is due', async () => {
    const db = dbWithRpc({ data: null, error: null })
    await expect(recordDueOccurrences(db as never, SCHEDULE, new Date(DUE.getTime() - 1))).resolves.toEqual({
      outcome: 'claimed_elsewhere',
    })
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('surfaces record errors and empty answers', async () => {
    await expect(recordDueOccurrences(dbWithRpc({ data: null, error: { message: 'x' } }) as never, SCHEDULE, new Date())).rejects.toThrow(/record/)
    await expect(recordDueOccurrences(dbWithRpc({ data: null, error: null }) as never, SCHEDULE, new Date())).rejects.toThrow(/nothing/)
  })

  it('claims, completes and fails with the claim token', async () => {
    const db = dbWithRpc({ data: [], error: null })
    expect(await claimOccurrences(db as never, { limit: 2 })).toEqual([])
    expect(db.rpc).toHaveBeenLastCalledWith('claim_newsletter_occurrences', { p_limit: 2, p_lease_seconds: 300, p_occurrence_id: null })

    db.rpc.mockResolvedValue({ data: true, error: null })
    expect(await completeOccurrence(db as never, { id: 'o', claim_token: 't' }, 'c')).toBe(true)

    db.rpc.mockResolvedValue({ data: null, error: null })
    expect(await failOccurrence(db as never, { id: 'o', claim_token: null }, 'boom', true)).toBe('lost')
    expect(db.rpc).toHaveBeenLastCalledWith('fail_newsletter_occurrence', {
      p_occurrence_id: 'o',
      p_claim_token: '',
      p_error: 'boom',
      p_retryable: true,
    })
  })

  it.each([
    ['claim', () => claimOccurrences(dbWithRpc({ data: null, error: { message: 'x' } }) as never, { limit: 1 })],
    ['complete', () => completeOccurrence(dbWithRpc({ data: null, error: { message: 'x' } }) as never, { id: 'o', claim_token: 't' }, 'c')],
    ['fail', () => failOccurrence(dbWithRpc({ data: null, error: { message: 'x' } }) as never, { id: 'o', claim_token: 't' }, 'e', false)],
    ['retry', () => retryOccurrence(dbWithRpc({ data: null, error: { message: 'x' } }) as never, 'o')],
  ])('surfaces %s errors', async (_label, call) => {
    await expect(call()).rejects.toThrow()
  })

  it('maps retry refusals to statuses', async () => {
    await expect(retryOccurrence(dbWithRpc({ data: null, error: null }) as never, 'o')).rejects.toBeInstanceOf(OccurrenceRetryError)
    await expect(retryOccurrence(dbWithRpc({ data: null, error: { code: 'P0002', message: 'nf' } }) as never, 'o')).rejects.toMatchObject({ status: 404 })
    await expect(retryOccurrence(dbWithRpc({ data: null, error: { code: 'CRM06', message: 'no' } }) as never, 'o')).rejects.toMatchObject({ status: 409 })
  })

  it('lists failed and skipped occurrences, newest first', async () => {
    const builder = createQueryBuilderMock({ data: [{ id: 'o' }], error: null })
    expect(await listAttentionOccurrences(createDbMock(builder) as never)).toEqual([{ id: 'o' }])
    expect(builder.argsFor('in')).toEqual(['status', ['failed', 'skipped']])

    const failing = createQueryBuilderMock({ data: null, error: { message: 'down' } })
    await expect(listAttentionOccurrences(createDbMock(failing) as never)).rejects.toThrow(/down/)
  })
})

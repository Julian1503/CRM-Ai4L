/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { readCampaignSendSummary } from './sendStatus'

/**
 * Responses are consumed one per await, in the order the summary asks for them:
 * pending count, failed count, sent count, then a reason lookup per non-empty bucket.
 */
function setup(responses: unknown[]) {
  const sends = createQueryBuilderMock(responses)

  return { db: createDbMock(() => sends), sends }
}

const count = (n: number) => ({ data: null, error: null, count: n })

describe('readCampaignSendSummary', () => {
  it('adds the buckets up into a total', async () => {
    const { db } = setup([count(2), count(0), count(5), count(5)])

    const summary = await readCampaignSendSummary(db as never, 'camp-1')

    expect(summary).toMatchObject({ pending: 2, failed: 0, sent: 5, total: 7 })
  })

  it('reports the provider message behind a failure', async () => {
    // The point of the whole report: "3 failed" is not something an operator can act
    // on, and the reason was only ever readable in the database.
    const { db } = setup([
      count(0),
      count(3),
      count(1),
      { data: { error: 'Automation not found.' }, error: null },
    ])

    const summary = await readCampaignSendSummary(db as never, 'camp-1')

    expect(summary.failureReason).toBe('Automation not found.')
    expect(summary.stallReason).toBeNull()
  })

  it('reports why the remaining recipients are waiting', async () => {
    const { db } = setup([
      count(4),
      count(0),
      count(1),
      { data: { error: 'Too many requests' }, error: null },
    ])

    const summary = await readCampaignSendSummary(db as never, 'camp-1')

    expect(summary.stallReason).toBe('Too many requests')
  })

  it('skips the reason lookups when nothing failed and nothing is pending', async () => {
    // A clean send should cost three head counts, not five round trips.
    const { db, sends } = setup([count(0), count(0), count(9)])

    const summary = await readCampaignSendSummary(db as never, 'camp-1')

    expect(summary).toMatchObject({ failureReason: null, stallReason: null, total: 9 })
    expect(sends.allFor('limit')).toHaveLength(0)
  })

  it('treats a blank error as no reason at all', async () => {
    // An empty string in the column would render as a dangling em dash.
    const { db } = setup([count(0), count(1), count(0), { data: { error: '  ' }, error: null }])

    expect((await readCampaignSendSummary(db as never, 'camp-1')).failureReason).toBeNull()
  })

  it('counts only the run it was asked about', async () => {
    // A re-sent campaign accumulates rows; summing every run would report "18 of 9
    // sent" the moment a campaign went out twice.
    const { db, sends } = setup([count(0), count(0), count(4)])

    const summary = await readCampaignSendSummary(db as never, 'camp-1', 2)

    expect(summary).toMatchObject({ run: 2, sent: 4, total: 4 })
    expect(sends.allFor('eq')).toContainEqual({ method: 'eq', args: ['run', 2] })
    expect(sends.allFor('eq')).not.toContainEqual({ method: 'eq', args: ['run', 1] })
  })

  it('reports the first run when no run is given', async () => {
    const { db } = setup([count(0), count(0), count(1)])

    expect((await readCampaignSendSummary(db as never, 'camp-1')).run).toBe(1)
  })

  it('surfaces a read failure rather than reporting zeroes', async () => {
    const { db } = setup([{ data: null, error: { message: 'permission denied' }, count: null }])

    await expect(readCampaignSendSummary(db as never, 'camp-1')).rejects.toThrow(
      'permission denied'
    )
  })
})

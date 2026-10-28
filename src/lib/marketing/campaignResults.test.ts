import { readCampaignBookingFunnels, readCampaignResults } from './campaignResults'

const mockSummaries = jest.fn()
jest.mock('./sendStatus', () => ({
  MAX_SUMMARY_BATCH: 3,
  readCampaignSendSummaries: (...args: unknown[]) => mockSummaries(...args),
}))

type Calls = { in?: unknown[]; range?: unknown[]; order: unknown[][] }

function fakeDb(rows: unknown[], funnelRows: unknown[], count = rows.length) {
  const calls: Calls = { order: [] }
  const query = {
    select: () => query,
    is: () => query,
    in: (...args: unknown[]) => ((calls.in = args), query),
    order: (...args: unknown[]) => (calls.order.push(args), query),
    range: (...args: unknown[]) => {
      calls.range = args
      return Promise.resolve({ data: rows, error: null, count })
    },
  }
  const rpc = jest.fn().mockResolvedValue({ data: funnelRows, error: null })
  return { db: { from: () => query, rpc } as never, calls, rpc }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSummaries.mockResolvedValue(new Map([['c1', { sent: 10 }]]))
})

describe('readCampaignResults', () => {
  it('reads one page of sent campaigns, newest send first, with their ledger and funnel', async () => {
    const { db, calls, rpc } = fakeDb(
      [
        { id: 'c1', name: 'One', status: 'sent', consent_stream: 'newsletter', started_at: 's', completed_at: 'e', send_run: 2, segment: { name: 'NSW' } },
        { id: 'c2', name: 'Two', status: 'failed', consent_stream: 'programs', started_at: null, completed_at: null, send_run: 1, segment: null },
      ],
      [{ campaign_id: 'c1', started: 4, paid: 2, booked: 1, cancelled: 0, charged_cents: '2500', last_booking_at: 't' }],
      30
    )

    const { results, total } = await readCampaignResults(db, { page: 2, pageSize: 10 })

    expect(total).toBe(30)
    expect(calls.in).toEqual(['status', ['sending', 'sent', 'failed']])
    expect(calls.range).toEqual([10, 19])
    expect(calls.order[0]).toEqual(['started_at', { ascending: false, nullsFirst: false }])
    expect(rpc).toHaveBeenCalledWith('campaign_booking_funnel', { p_campaign_ids: ['c1', 'c2'] })

    expect(results[0]).toEqual(
      expect.objectContaining({
        id: 'c1',
        segmentName: 'NSW',
        run: 2,
        send: { sent: 10 },
        funnel: { started: 4, paid: 2, booked: 1, cancelled: 0, chargedCents: 2500, lastBookingAt: 't' },
      })
    )
    // A campaign the funnel has no row for reads as zeros, not as missing.
    expect(results[1]).toEqual(
      expect.objectContaining({
        segmentName: null,
        send: null,
        funnel: { started: 0, paid: 0, booked: 0, cancelled: 0, chargedCents: 0, lastBookingAt: null },
      })
    )
  })

  it('surfaces a failed read instead of answering an empty page', async () => {
    const query = {
      select: () => query,
      is: () => query,
      in: () => query,
      order: () => query,
      range: () => Promise.resolve({ data: null, error: { message: 'timeout' }, count: null }),
    }

    await expect(readCampaignResults({ from: () => query } as never, { page: 1, pageSize: 25 })).rejects.toThrow(
      'Could not load campaign results: timeout'
    )
  })
})

describe('readCampaignBookingFunnels', () => {
  it('asks for nothing when there are no campaigns', async () => {
    const { db, rpc } = fakeDb([], [])

    expect((await readCampaignBookingFunnels(db, [])).size).toBe(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses more campaigns than one call may carry', async () => {
    const { db } = fakeDb([], [])

    await expect(readCampaignBookingFunnels(db, ['a', 'b', 'c', 'd'])).rejects.toThrow(/At most 3/)
  })

  it('reports a database error', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'denied' } })

    await expect(readCampaignBookingFunnels({ rpc } as never, ['a'])).rejects.toThrow(
      'Could not read campaign bookings: denied'
    )
  })
})

/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { AudienceTooLargeError, countCampaignAudience, prepareCampaignRun } from './runs'

const mockAudienceQuery = jest.fn()
jest.mock('./segments', () => ({
  SEGMENT_MEMBER_CAP: 10_000,
  segmentAudienceQuery: (...args: unknown[]) => mockAudienceQuery(...args),
}))

const campaign = {
  id: 'camp-1',
  send_run: 2,
  segment_id: 'seg-1',
  consent_stream: 'newsletter' as const,
  revision: 3,
  approved_revision: 3,
}

/** An audience served in keyset pages, like PostgREST with a row cap of `cap`. */
function audience(ids: string[], cap = 2, count = ids.length) {
  const cursors: Array<string | null> = []
  mockAudienceQuery.mockImplementation(async () => {
    let after: string | null = null
    let limit = Infinity
    const query: Record<string, unknown> = {
      order: () => query,
      gt: (_column: string, value: string) => {
        after = value
        return query
      },
      limit: (value: number) => {
        limit = value
        return query
      },
      range: () => query,
      then: (resolve: (value: unknown) => unknown) => {
        cursors.push(after)
        const rest = ids.filter((id) => after === null || id > after)
        return Promise.resolve({
          data: rest.slice(0, Math.min(limit, cap)).map((id) => ({ id })),
          error: null,
          count,
        }).then(resolve)
      },
    }
    return { query }
  })
  return { cursors }
}

function db(options: { run?: unknown; ledgerCounts?: number[] } = {}) {
  const segments = createQueryBuilderMock({ data: { definition: {} }, error: null })
  const runs = createQueryBuilderMock([
    { data: options.run ?? null, error: null },
    { data: null, error: null }, // upsert
    { data: { audience_status: 'preparing', audience_cursor: null, segment_id: 'seg-1', consent_stream: 'newsletter' }, error: null },
    { data: null, error: null }, // progress updates…
  ])
  const counts = options.ledgerCounts ?? [2, 3, 3]
  const sends = createQueryBuilderMock([
    ...counts.flatMap((count) => [{ data: null, error: null }, { data: null, error: null, count }]),
    { data: null, error: null, count: counts.at(-1) },
  ])
  const client = createDbMock((table: string) =>
    table === 'segments' ? segments : table === 'campaign_runs' ? runs : sends
  )
  return { client: client as never, runs, sends }
}

describe('prepareCampaignRun (H7)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('refuses a campaign whose approval is not for its current revision', async () => {
    const { client } = db()
    await expect(prepareCampaignRun(client, { ...campaign, approved_revision: 2 })).rejects.toThrow(/approved in its current form/)
  })

  it('returns an already prepared run without touching the audience', async () => {
    const { client } = db({ run: { audience_status: 'prepared', prepared_count: 9 } })

    await expect(prepareCampaignRun(client, campaign)).resolves.toMatchObject({ prepared_count: 9 })
    expect(mockAudienceQuery).not.toHaveBeenCalled()
  })

  it('pages past a row cap by keyset until an empty page, not until a short one', async () => {
    const { cursors } = audience(['a', 'b', 'c'], 2)
    const { client, sends } = db()

    await prepareCampaignRun(client, campaign)

    // Page 1 (cap 2 of 500 requested) must not be taken as the end.
    expect(cursors).toEqual(expect.arrayContaining([null, 'b', 'c']))
    const inserted = sends.allFor('upsert').flatMap((call) => (call.args[0] as Array<{ contact_id: string }>).map((row) => row.contact_id))
    expect(inserted).toEqual(['a', 'b', 'c'])
    expect(sends.allFor('upsert')[0].args[1]).toMatchObject({ onConflict: 'campaign_id,contact_id,run', ignoreDuplicates: true })
  })

  it('records the expected count and the run it belongs to', async () => {
    audience(['a'], 500, 1)
    const { client, runs } = db({ ledgerCounts: [1] })

    await prepareCampaignRun(client, campaign)

    expect(runs.argsFor('upsert')?.[0]).toMatchObject({ campaign_id: 'camp-1', run: 2, revision: 3, expected_count: 1 })
  })

  it('refuses an audience over the cap before materialising anything', async () => {
    audience([], 500, 10_001)
    const { client, sends } = db()

    await expect(prepareCampaignRun(client, campaign)).rejects.toBeInstanceOf(AudienceTooLargeError)
    expect(sends.allFor('upsert')).toHaveLength(0)
  })

  it('refuses an empty audience', async () => {
    audience([], 500, 0)
    const { client } = db()

    await expect(prepareCampaignRun(client, campaign)).rejects.toThrow(/matches no subscribed contacts/)
  })
})

describe('countCampaignAudience', () => {
  it('counts without reading rows', async () => {
    audience(['a', 'b'], 500, 42)
    const { client } = db()

    await expect(countCampaignAudience(client, { segmentId: 'seg-1', definition: {}, stream: 'newsletter' })).resolves.toBe(42)
  })
})

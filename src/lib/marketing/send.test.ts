/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import type { CampaignProvider } from './providers/types'
import { EMAILOCTOPUS_CAPABILITIES } from './providers/emailOctopus'
import { TokenBucket } from './rateLimiter'
import { BOOKING_URL_MERGE_FIELD } from './mergeFields'
import { executeCampaignSends, prepareCampaignSends } from './send'

function contactRow(id: string, email = `${id}@example.com`) {
  return { id, contact_id: id, contact: { email, first_name: 'A', last_name: 'B' } }
}

function fakeProvider(overrides: Partial<CampaignProvider> = {}): CampaignProvider {
  return {
    name: 'fake',
    capabilities: EMAILOCTOPUS_CAPABILITIES,
    setContactFields: jest.fn().mockResolvedValue({ ok: true, reference: null }),
    triggerSend: jest.fn().mockResolvedValue({ ok: true, reference: 'ref-1' }),
    ...overrides,
  }
}

/** Bucket with an injected clock so tests never actually wait. */
function fastBucket() {
  let now = 0
  return new TokenBucket({
    capacity: 100,
    refillPerSecond: 10,
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  })
}

const campaign = {
  id: 'camp-1',
  provider_automation_id: 'auto-1',
  merge_fields: {} as Record<string, string>,
}

describe('prepareCampaignSends', () => {
  it('creates one pending row per member', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(builder)

    const count = await prepareCampaignSends(db as never, 'camp-1', [
      { id: 'c1', email: 'a@example.com', first_name: 'A', last_name: 'B' },
      { id: 'c2', email: 'b@example.com', first_name: 'C', last_name: 'D' },
    ])

    expect(count).toBe(2)
    const [rows] = builder.argsFor('upsert') as [Record<string, unknown>[]]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ campaign_id: 'camp-1', status: 'pending' })
  })

  it('ignores duplicates so re-preparing tops up rather than failing', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(builder)

    await prepareCampaignSends(db as never, 'camp-1', [
      { id: 'c1', email: 'a@example.com', first_name: 'A', last_name: 'B' },
    ])

    const [, options] = builder.argsFor('upsert') as [unknown, Record<string, unknown>]
    expect(options).toMatchObject({
      onConflict: 'campaign_id,contact_id',
      ignoreDuplicates: true,
    })
  })

  it('does not hit the database for an empty segment', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(builder)

    expect(await prepareCampaignSends(db as never, 'camp-1', [])).toBe(0)
    expect(db.from).not.toHaveBeenCalled()
  })
})

describe('executeCampaignSends', () => {
  function setup(pending: unknown[]) {
    const sends = createQueryBuilderMock({ data: pending, error: null })
    const db = createDbMock(sends)
    return { db, sends }
  }

  it('sends to each pending recipient', async () => {
    const { db } = setup([contactRow('c1'), contactRow('c2')])
    const provider = fakeProvider()

    const progress = await executeCampaignSends(db as never, provider, campaign, {
      bucket: fastBucket(),
    })

    expect(progress).toMatchObject({ total: 2, sent: 2, failed: 0, remaining: 0 })
    expect(provider.triggerSend).toHaveBeenCalledTimes(2)
  })

  it('queues into the configured automation', async () => {
    const { db } = setup([contactRow('c1')])
    const provider = fakeProvider()

    await executeCampaignSends(db as never, provider, campaign, { bucket: fastBucket() })

    expect(provider.triggerSend).toHaveBeenCalledWith(
      expect.objectContaining({ campaignHandle: 'auto-1', email: 'c1@example.com' })
    )
  })

  it('only loads pending rows, so a resumed run does not re-send', async () => {
    const { db, sends } = setup([contactRow('c1')])

    await executeCampaignSends(db as never, fakeProvider(), campaign, { bucket: fastBucket() })

    expect(sends.allFor('eq')).toContainEqual({ method: 'eq', args: ['status', 'pending'] })
  })

  it('bounds one invocation so a large segment can be chunked', async () => {
    const { db, sends } = setup([contactRow('c1')])

    await executeCampaignSends(db as never, fakeProvider(), campaign, {
      maxToProcess: 250,
      bucket: fastBucket(),
    })

    expect(sends.argsFor('limit')).toEqual([250])
  })

  it('paces every send through the rate limiter', async () => {
    const { db } = setup([contactRow('c1'), contactRow('c2'), contactRow('c3')])
    const bucket = fastBucket()
    const acquire = jest.spyOn(bucket, 'acquire')

    await executeCampaignSends(db as never, fakeProvider(), campaign, { bucket })

    expect(acquire).toHaveBeenCalledTimes(3)
  })

  it('writes merge fields before triggering, since the body cannot be supplied', async () => {
    const { db } = setup([contactRow('c1')])
    const provider = fakeProvider()
    const order: string[] = []
    ;(provider.setContactFields as jest.Mock).mockImplementation(async () => {
      order.push('fields')
      return { ok: true, reference: null }
    })
    ;(provider.triggerSend as jest.Mock).mockImplementation(async () => {
      order.push('send')
      return { ok: true, reference: null }
    })

    await executeCampaignSends(
      db as never,
      provider,
      { ...campaign, merge_fields: { OfferHeadline: 'Free consult' } },
      { bucket: fastBucket() }
    )

    expect(order).toEqual(['fields', 'send'])
  })

  it('skips the field write when there is nothing to personalise', async () => {
    const { db } = setup([contactRow('c1')])
    const provider = fakeProvider()

    await executeCampaignSends(db as never, provider, campaign, { bucket: fastBucket() })

    expect(provider.setContactFields).not.toHaveBeenCalled()
  })

  describe('booking links', () => {
    /** campaign_sends reads first; controlled booking RPC returns one id per recipient. */
    function setupWithBookings(pending: unknown[]) {
      const builder = createQueryBuilderMock({ data: pending, error: null })
      const db = createDbMock(builder)
      pending.forEach((_, index) => {
        db.rpc.mockResolvedValueOnce({ data: `bk-${index + 1}`, error: null })
      })
      return { db, builder }
    }

    it('gives each recipient a booking link', async () => {
      // Without this the campaign email has no call to action and the entire
      // consultation funnel is unreachable.
      const { db } = setupWithBookings([contactRow('c1')])
      const provider = fakeProvider()

      await executeCampaignSends(db as never, provider, campaign, {
        bucket: fastBucket(),
        baseUrl: 'https://crm.example.com',
      })

      const [, fields] = (provider.setContactFields as jest.Mock).mock.calls[0]
      expect(fields[BOOKING_URL_MERGE_FIELD]).toMatch(
        /^https:\/\/crm\.example\.com\/book\/[A-Za-z0-9_-]{43,}$/
      )
    })

    it('gives different recipients different links', async () => {
      // A shared link would let the first recipient consume everyone's booking.
      const { db } = setupWithBookings([contactRow('c1'), contactRow('c2')])
      const provider = fakeProvider()

      await executeCampaignSends(db as never, provider, campaign, {
        bucket: fastBucket(),
        baseUrl: 'https://crm.example.com',
      })

      const calls = (provider.setContactFields as jest.Mock).mock.calls
      expect(calls[0][1][BOOKING_URL_MERGE_FIELD]).not.toBe(
        calls[1][1][BOOKING_URL_MERGE_FIELD]
      )
    })

    it('keeps the campaign merge fields alongside the link', async () => {
      const { db } = setupWithBookings([contactRow('c1')])
      const provider = fakeProvider()

      await executeCampaignSends(
        db as never,
        provider,
        { ...campaign, merge_fields: { Headline: 'Free consult' } },
        { bucket: fastBucket(), baseUrl: 'https://crm.example.com' }
      )

      const [, fields] = (provider.setContactFields as jest.Mock).mock.calls[0]
      expect(fields.Headline).toBe('Free consult')
      expect(fields[BOOKING_URL_MERGE_FIELD]).toBeDefined()
    })

    it('does not double the slash when baseUrl has a trailing one', async () => {
      const { db } = setupWithBookings([contactRow('c1')])
      const provider = fakeProvider()

      await executeCampaignSends(db as never, provider, campaign, {
        bucket: fastBucket(),
        baseUrl: 'https://crm.example.com/',
      })

      const [, fields] = (provider.setContactFields as jest.Mock).mock.calls[0]
      expect(fields[BOOKING_URL_MERGE_FIELD]).not.toContain('.com//book')
    })

    it('records the booking against the campaign and contact', async () => {
      const { db } = setupWithBookings([contactRow('c1')])

      await executeCampaignSends(db as never, fakeProvider(), campaign, {
        bucket: fastBucket(),
        baseUrl: 'https://crm.example.com',
      })

      expect(db.rpc).toHaveBeenCalledWith(
        'create_campaign_booking',
        expect.objectContaining({ p_contact_id: 'c1', p_campaign_id: 'camp-1' })
      )
    })

    it('fails the recipient rather than sending a dead link', async () => {
      // An email whose call to action goes nowhere is worse than no email.
      const builder = createQueryBuilderMock([
        { data: [contactRow('c1')], error: null },
      ])
      const db = createDbMock(builder)
      db.rpc.mockResolvedValue({ data: null, error: { message: 'insert denied' } })
      const provider = fakeProvider()

      const progress = await executeCampaignSends(
        db as never,
        provider,
        campaign,
        { bucket: fastBucket(), baseUrl: 'https://crm.example.com' }
      )

      expect(progress).toMatchObject({ sent: 0, failed: 1 })
      expect(provider.triggerSend).not.toHaveBeenCalled()
    })

    it('sends without a link when no baseUrl is configured', async () => {
      const { db } = setup([contactRow('c1')])
      const provider = fakeProvider()

      await executeCampaignSends(db as never, provider, campaign, { bucket: fastBucket() })

      expect(provider.setContactFields).not.toHaveBeenCalled()
      expect(provider.triggerSend).toHaveBeenCalled()
    })
  })

  it('records a non-retryable failure and moves on', async () => {
    const { db, sends } = setup([contactRow('c1'), contactRow('c2')])
    const provider = fakeProvider({
      triggerSend: jest
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'Bad contact', retryable: false })
        .mockResolvedValueOnce({ ok: true, reference: 'r' }),
    })

    const progress = await executeCampaignSends(db as never, provider, campaign, {
      bucket: fastBucket(),
    })

    expect(progress).toMatchObject({ sent: 1, failed: 1 })
    const update = sends.argsFor('update') as [Record<string, unknown>]
    expect(update[0].status).toBe('failed')
  })

  it('leaves a retryable failure pending for the next run', async () => {
    const { db, sends } = setup([contactRow('c1')])
    const provider = fakeProvider({
      triggerSend: jest.fn().mockResolvedValue({ ok: false, error: '429', retryable: true }),
    })

    const progress = await executeCampaignSends(db as never, provider, campaign, {
      bucket: fastBucket(),
    })

    expect(progress).toMatchObject({ sent: 0, failed: 0, remaining: 1 })
    // No status write at all: the row stays pending.
    expect(sends.allFor('update')).toHaveLength(0)
  })

  it('stalls the whole bucket on a provider backoff', async () => {
    // Backing off one call while the rest keep firing just prolongs rate limiting.
    const { db } = setup([contactRow('c1')])
    const bucket = fastBucket()
    const pauseFor = jest.spyOn(bucket, 'pauseFor')
    const provider = fakeProvider({
      triggerSend: jest
        .fn()
        .mockResolvedValue({ ok: false, error: '429', retryable: true, retryAfterMs: 4000 }),
    })

    await executeCampaignSends(db as never, provider, campaign, { bucket })

    expect(pauseFor).toHaveBeenCalledWith(4000)
  })

  it('fails a recipient with no email rather than calling the provider', async () => {
    const { db } = setup([{ id: 's1', contact_id: 'c1', contact: null }])
    const provider = fakeProvider()

    const progress = await executeCampaignSends(db as never, provider, campaign, {
      bucket: fastBucket(),
    })

    expect(progress).toMatchObject({ failed: 1 })
    expect(provider.triggerSend).not.toHaveBeenCalled()
  })

  it('surfaces a ledger read failure', async () => {
    const sends = createQueryBuilderMock({ data: null, error: { message: 'db down' } })

    await expect(
      executeCampaignSends(createDbMock(sends) as never, fakeProvider(), campaign, {
        bucket: fastBucket(),
      })
    ).rejects.toThrow(/db down/)
  })
})

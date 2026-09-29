/**
 * @jest-environment node
 */
import type { ClaimedCampaignSend } from '@/lib/db/types'

import { BOOKING_URL_MERGE_FIELD } from './mergeFields'
import { EMAILOCTOPUS_CAPABILITIES } from './providers/emailOctopus'
import type { CampaignProvider, SendOutcome } from './providers/types'
import { TokenBucket } from './rateLimiter'
import { executeCampaignSends, LedgerWriteError } from './send'

/**
 * An in-memory stand-in for the ledger RPCs (claim_campaign_sends,
 * begin_campaign_dispatch, complete_campaign_send, create_campaign_booking).
 * The real SQL is exercised by supabase/tests/verify_20261003000000.sql and the
 * integration suite; this pins down what the TypeScript does with each answer.
 */
function ledger(
  claims: Array<Partial<ClaimedCampaignSend>>,
  options: {
    begin?: (id: string) => 'go' | 'lost' | 'skipped'
    complete?: (id: string, status: string) => boolean | { error: string }
    bookingError?: string
  } = {}
) {
  const outcomes: Array<{ id: string; status: string; reference?: unknown; error?: unknown }> = []
  const begun: string[] = []
  const rows: ClaimedCampaignSend[] = claims.map((row, index) => ({
    send_id: `s${index + 1}`,
    contact_id: `c${index + 1}`,
    email: `c${index + 1}@example.com`,
    first_name: 'A',
    last_name: 'B',
    claim_token: `t${index + 1}`,
    ...row,
  }))

  const rpc = jest.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'claim_campaign_sends') return { data: rows.slice(0, args.p_limit as number), error: null }
    if (fn === 'begin_campaign_dispatch') {
      begun.push(args.p_send_id as string)
      return { data: options.begin?.(args.p_send_id as string) ?? 'go', error: null }
    }
    if (fn === 'complete_campaign_send') {
      const answer = options.complete?.(args.p_send_id as string, args.p_status as string) ?? true
      if (typeof answer === 'object') return { data: null, error: { message: answer.error } }
      if (answer) {
        outcomes.push({
          id: args.p_send_id as string,
          status: args.p_status as string,
          reference: args.p_reference,
          error: args.p_error,
        })
      }
      return { data: answer, error: null }
    }
    if (fn === 'create_campaign_booking') {
      return options.bookingError
        ? { data: null, error: { message: options.bookingError } }
        : { data: 'booking-1', error: null }
    }
    throw new Error(`unexpected rpc ${fn}`)
  })

  return { db: { rpc } as never, rpc, outcomes, begun }
}

function provider(trigger: SendOutcome | ((email: string) => SendOutcome) = { ok: true, reference: 'ref' }) {
  const triggerSend = jest.fn(async ({ email }: { email: string }) =>
    typeof trigger === 'function' ? trigger(email) : trigger
  )
  const setContactFields = jest.fn(async (): Promise<SendOutcome> => ({ ok: true, reference: null }))
  const fake: CampaignProvider = { name: 'fake', capabilities: EMAILOCTOPUS_CAPABILITIES, triggerSend, setContactFields }
  return { fake, triggerSend, setContactFields }
}

function fastBucket() {
  let now = 0
  return new TokenBucket({ capacity: 100, refillPerSecond: 10, now: () => now, sleep: async (ms) => { now += ms } })
}

const campaign = { id: 'camp-1', provider_automation_id: 'auto-1', merge_fields: {}, send_run: 2 }

describe('executeCampaignSends', () => {
  it('claims through the database, scoped to the run, with a bounded chunk', async () => {
    const { db, rpc } = ledger([{}, {}, {}])

    await executeCampaignSends(db, provider().fake, campaign, { maxToProcess: 2, bucket: fastBucket() })

    expect(rpc).toHaveBeenCalledWith('claim_campaign_sends', expect.objectContaining({
      p_campaign_id: 'camp-1',
      p_run: 2,
      p_limit: 2,
    }))
  })

  it('sends each claimed recipient and records the outcome under the claim token', async () => {
    const { db, rpc, outcomes } = ledger([{}, {}])
    const { fake, triggerSend } = provider({ ok: true, reference: 'ref-9' })

    const progress = await executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })

    expect(triggerSend).toHaveBeenCalledTimes(2)
    expect(triggerSend).toHaveBeenCalledWith(expect.objectContaining({ campaignHandle: 'auto-1', email: 'c1@example.com' }))
    expect(outcomes).toEqual([
      { id: 's1', status: 'sent', reference: 'ref-9', error: null },
      { id: 's2', status: 'sent', reference: 'ref-9', error: null },
    ])
    expect(rpc).toHaveBeenCalledWith('complete_campaign_send', expect.objectContaining({ p_token: 't1' }))
    expect(progress).toMatchObject({ total: 2, sent: 2, failed: 0, uncertain: 0 })
  })

  it('checks eligibility immediately before the provider call and skips a withdrawn contact (H4)', async () => {
    const { db, begun } = ledger([{}, {}], { begin: (id) => (id === 's1' ? 'skipped' : 'go') })
    const { fake, triggerSend } = provider()

    const progress = await executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })

    expect(begun).toEqual(['s1', 's2'])
    expect(triggerSend).toHaveBeenCalledTimes(1)
    expect(triggerSend).toHaveBeenCalledWith(expect.objectContaining({ email: 'c2@example.com' }))
    expect(progress).toMatchObject({ sent: 1, skipped: 1 })
  })

  it('does not contact the provider for a claim it has lost', async () => {
    const { db } = ledger([{}], { begin: () => 'lost' })
    const { fake, triggerSend } = provider()

    const progress = await executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })

    expect(triggerSend).not.toHaveBeenCalled()
    expect(progress.lost).toBe(1)
  })

  it('never counts a success it could not record as its own (stale worker)', async () => {
    const { db } = ledger([{}], { complete: () => false })

    const progress = await executeCampaignSends(db, provider().fake, campaign, { bucket: fastBucket() })

    expect(progress).toMatchObject({ sent: 0, lost: 1 })
  })

  it('halts the chunk when a provider success cannot be written to the ledger (H3)', async () => {
    const { db } = ledger([{}, {}], { complete: () => ({ error: 'connection reset' }) })
    const { fake, triggerSend } = provider()

    await expect(executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })).rejects.toBeInstanceOf(
      LedgerWriteError
    )
    // The second recipient is not emailed while outcomes cannot be recorded.
    expect(triggerSend).toHaveBeenCalledTimes(1)
  })

  it('records an ambiguous provider outcome as uncertain, never as retryable (H3)', async () => {
    const { db, outcomes } = ledger([{}])
    const { fake } = provider({ ok: false, retryable: false, ambiguous: true, error: 'No reply' })

    const progress = await executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })

    expect(outcomes).toEqual([{ id: 's1', status: 'uncertain', reference: null, error: 'No reply' }])
    expect(progress).toMatchObject({ uncertain: 1, remaining: 0 })
  })

  it('returns a rate-limited recipient to the queue and pauses the bucket', async () => {
    const { db, outcomes } = ledger([{}])
    const { fake } = provider({ ok: false, retryable: true, retryAfterMs: 4000, error: 'Too many requests' })
    const bucket = fastBucket()
    const pause = jest.spyOn(bucket, 'pauseFor')

    const progress = await executeCampaignSends(db, fake, campaign, { bucket })

    expect(outcomes).toEqual([{ id: 's1', status: 'pending', reference: null, error: 'Too many requests' }])
    expect(pause).toHaveBeenCalledWith(4000)
    expect(progress).toMatchObject({ remaining: 1, deferredReason: 'Too many requests' })
  })

  it('fails a refused recipient and keeps the first reason', async () => {
    const { db } = ledger([{}, {}])
    const { fake } = provider((email) => ({ ok: false, retryable: false, error: `bad ${email}` }))

    const progress = await executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })

    expect(progress).toMatchObject({ failed: 2, failureReason: 'bad c1@example.com' })
  })

  it('fails a recipient with no email without calling the provider', async () => {
    const { db, outcomes } = ledger([{ email: null }])
    const { fake, triggerSend } = provider()

    await executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })

    expect(triggerSend).not.toHaveBeenCalled()
    expect(outcomes[0]).toMatchObject({ status: 'failed', error: 'Contact has no email address.' })
  })

  it('surfaces a claim failure', async () => {
    const rpc = jest.fn(async () => ({ data: null, error: { message: 'permission denied' } }))

    await expect(
      executeCampaignSends({ rpc } as never, provider().fake, campaign, { bucket: fastBucket() })
    ).rejects.toBeInstanceOf(LedgerWriteError)
  })

  it('counts a refusal it could not record as lost, not failed', async () => {
    const { db } = ledger([{}], { complete: () => false })
    const { fake } = provider({ ok: false, retryable: false, error: 'Rejected' })

    const progress = await executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })

    expect(progress).toMatchObject({ failed: 0, lost: 1 })
  })

  it('counts a deferral it could not record as lost', async () => {
    const { db } = ledger([{}], { complete: () => false })
    const { fake } = provider({ ok: false, retryable: true, error: 'Slow down' })

    const progress = await executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })

    expect(progress).toMatchObject({ remaining: 0, lost: 1 })
  })

  it('counts an uncertain outcome it could not record as lost', async () => {
    const { db } = ledger([{}], { complete: () => false })
    const { fake } = provider({ ok: false, retryable: false, ambiguous: true, error: 'No reply' })

    expect((await executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })).lost).toBe(1)
  })

  it('surfaces a dispatch-start failure before contacting the provider', async () => {
    const { db, rpc } = ledger([{}])
    rpc.mockImplementation(async (fn: string) =>
      fn === 'claim_campaign_sends'
        ? { data: [{ send_id: 's1', contact_id: 'c1', email: 'c1@example.com', first_name: 'A', last_name: 'B', claim_token: 't1' }], error: null }
        : { data: null, error: { message: 'timeout' } }
    )
    const { fake, triggerSend } = provider()

    await expect(executeCampaignSends(db, fake, campaign, { bucket: fastBucket() })).rejects.toBeInstanceOf(LedgerWriteError)
    expect(triggerSend).not.toHaveBeenCalled()
  })

  describe('personalisation and booking links', () => {
    it('writes merge fields, including a per-recipient booking link, before triggering', async () => {
      const { db } = ledger([{}])
      const { fake, setContactFields, triggerSend } = provider()

      await executeCampaignSends(db, fake, { ...campaign, merge_fields: { Headline: 'Hi' } }, {
        bucket: fastBucket(),
        baseUrl: 'https://crm.example.com/',
      })

      const [, fields] = setContactFields.mock.calls[0] as unknown as [string, Record<string, string>]
      expect(fields.Headline).toBe('Hi')
      expect(fields[BOOKING_URL_MERGE_FIELD]).toMatch(/^https:\/\/crm\.example\.com\/book\/[A-Za-z0-9_-]+$/)
      expect(setContactFields.mock.invocationCallOrder[0]).toBeLessThan(triggerSend.mock.invocationCallOrder[0])
    })

    it('fails the recipient rather than sending a dead booking link', async () => {
      const { db, outcomes } = ledger([{}], { bookingError: 'No pending campaign send' })
      const { fake, triggerSend } = provider()

      await executeCampaignSends(db, fake, campaign, { bucket: fastBucket(), baseUrl: 'https://crm.example.com' })

      expect(triggerSend).not.toHaveBeenCalled()
      expect(outcomes[0].status).toBe('failed')
    })

    it('fails a recipient whose field write was refused outright', async () => {
      const { db, outcomes } = ledger([{}])
      const { fake, setContactFields, triggerSend } = provider()
      setContactFields.mockResolvedValueOnce({ ok: false, retryable: false, error: 'Unknown field' })

      await executeCampaignSends(db, fake, { ...campaign, merge_fields: { Headline: 'Hi' } }, { bucket: fastBucket() })

      expect(triggerSend).not.toHaveBeenCalled()
      expect(outcomes[0]).toMatchObject({ status: 'failed', error: 'Unknown field' })
    })

    it('defers a recipient whose field write was rate limited, before any send attempt', async () => {
      const { db, outcomes, begun } = ledger([{}])
      const { fake, setContactFields, triggerSend } = provider()
      setContactFields.mockResolvedValueOnce({ ok: false, retryable: true, error: 'slow down' })

      await executeCampaignSends(db, fake, { ...campaign, merge_fields: { Headline: 'Hi' } }, { bucket: fastBucket() })

      expect(begun).toEqual([])
      expect(triggerSend).not.toHaveBeenCalled()
      expect(outcomes[0].status).toBe('pending')
    })
  })
})

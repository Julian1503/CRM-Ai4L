/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { EMAILOCTOPUS_CAPABILITIES } from './providers/emailOctopus'
import type { CampaignProvider, SendOutcome } from './providers/types'
import { listTestSends, readTestRecipients, readTestStatus, sendCampaignTest, TEST_BOOKING_TOKEN } from './testSend'

const CAMPAIGN = {
  id: 'camp-1',
  revision: 3,
  provider_automation_id: 'auto-1',
  merge_fields: { Headline: 'Hi', PrefsUrl: 'https://forged', Newsletter: 'yes' },
  content_snapshot_id: null,
  archived_at: null,
  removed_at: null,
}

const SETTLED = { id: 'ts-1', revision: 3, recipient: 'qa@ai4l.com.au', outcome: 'sent', error: null, created_at: 'now' }

function provider(trigger: SendOutcome = { ok: true, reference: 'r' }, fields: SendOutcome = { ok: true, reference: null }) {
  const setContactFields = jest.fn(async () => fields)
  const triggerSend = jest.fn(async () => trigger)
  const fake: CampaignProvider = { name: 'fake', capabilities: EMAILOCTOPUS_CAPABILITIES, setContactFields, triggerSend }
  return { fake, setContactFields, triggerSend }
}

function setup(options: { campaign?: unknown; insert?: unknown; settle?: unknown } = {}) {
  const campaigns = createQueryBuilderMock({ data: options.campaign === undefined ? CAMPAIGN : options.campaign, error: null })
  const testSends = createQueryBuilderMock([options.insert ?? { data: { id: 'ts-1' }, error: null }, options.settle ?? { data: SETTLED, error: null }])
  const other = createQueryBuilderMock({ data: null, error: null })
  const db = createDbMock((table: string) => (table === 'campaigns' ? campaigns : table === 'campaign_test_sends' ? testSends : other))
  return { db: db as never, campaigns, testSends, from: db.from, rpc: db.rpc }
}

const ALLOW = ['qa@ai4l.com.au']
const base = { recipient: 'QA@ai4l.com.au ', revision: 3, allowlist: ALLOW, baseUrl: 'https://crm.example.com/' }

describe('readTestRecipients', () => {
  it('keeps valid, lowercased, unique addresses; empty means off', () => {
    expect(readTestRecipients({ CAMPAIGN_TEST_RECIPIENTS: ' QA@ai4l.com.au, qa@ai4l.com.au ,nope, b@x.io ' })).toEqual(['qa@ai4l.com.au', 'b@x.io'])
    expect(readTestRecipients({})).toEqual([])
  })
})

describe('sendCampaignTest', () => {
  it('sends the current content to the allowlisted recipient only, with a test booking link', async () => {
    const { db, testSends, from, rpc } = setup()
    const { fake, setContactFields, triggerSend } = provider()

    const outcome = await sendCampaignTest(db, 'camp-1', { ...base, provider: fake })

    expect(outcome).toEqual({ kind: 'done', testSend: SETTLED, note: expect.stringMatching(/cannot book/) })
    expect(setContactFields).toHaveBeenCalledWith('qa@ai4l.com.au', {
      Headline: 'Hi',
      BookingUrl: `https://crm.example.com/book/${TEST_BOOKING_TOKEN}`,
    })
    expect(triggerSend).toHaveBeenCalledWith(expect.objectContaining({ campaignHandle: 'auto-1', email: 'qa@ai4l.com.au' }))
    expect(testSends.argsFor('insert')).toEqual([{ campaign_id: 'camp-1', revision: 3, recipient: 'qa@ai4l.com.au' }])
    expect(testSends.argsFor('update')).toEqual([{ outcome: 'sent', error: null, provider_reference: 'r' }])
    // Not a delivery: no ledger, run, booking or campaign update.
    expect(from.mock.calls.map(([table]) => table)).not.toEqual(expect.arrayContaining(['campaign_sends', 'campaign_runs', 'bookings']))
    expect(rpc).not.toHaveBeenCalled()
  })

  it('omits the booking link with a note when there is no app origin', async () => {
    const { db } = setup()
    const { fake, setContactFields } = provider()

    const outcome = await sendCampaignTest(db, 'camp-1', { ...base, baseUrl: null, provider: fake })

    expect(setContactFields).toHaveBeenCalledWith('qa@ai4l.com.au', { Headline: 'Hi' })
    expect(outcome).toMatchObject({ note: expect.stringMatching(/NEXT_PUBLIC_APP_URL/) })
  })

  it.each([
    ['an address that is not on the allowlist', { recipient: 'someone@else.com' }, 'bad_request'],
    ['a stale revision', { revision: 2 }, 'conflict'],
  ])('refuses %s before contacting anyone', async (_label, change, kind) => {
    const { db, testSends } = setup()
    const { fake, triggerSend } = provider()

    expect(await sendCampaignTest(db, 'camp-1', { ...base, ...change, provider: fake })).toMatchObject({ kind })
    expect(triggerSend).not.toHaveBeenCalled()
    expect(testSends.argsFor('insert')).toBeUndefined()
  })

  it.each([
    ['missing', null, 'not_found'],
    ['removed', { ...CAMPAIGN, removed_at: 'x' }, 'not_found'],
    ['archived', { ...CAMPAIGN, archived_at: 'x' }, 'conflict'],
    ['without an automation', { ...CAMPAIGN, provider_automation_id: ' ' }, 'conflict'],
  ])('refuses a campaign that is %s', async (_label, campaign, kind) => {
    const { db } = setup({ campaign })
    expect(await sendCampaignTest(db, 'camp-1', { ...base, provider: provider().fake })).toMatchObject({ kind })
  })

  it('maps the database rate limit and a revision that moved on', async () => {
    const limited = setup({ insert: { data: null, error: { code: 'CRM09', message: 'At most 5 test sends per campaign per hour.' } } })
    expect(await sendCampaignTest(limited.db, 'camp-1', { ...base, provider: provider().fake })).toEqual({
      kind: 'rate_limited',
      message: 'At most 5 test sends per campaign per hour.',
    })

    const stale = setup({ insert: { data: null, error: { code: 'CRM06', message: 'changed' } } })
    expect(await sendCampaignTest(stale.db, 'camp-1', { ...base, provider: provider().fake })).toMatchObject({ kind: 'conflict' })

    const broken = setup({ insert: { data: null, error: { message: 'down' } } })
    await expect(sendCampaignTest(broken.db, 'camp-1', { ...base, provider: provider().fake })).rejects.toThrow('down')
  })

  it('records a refused field write as failed without queuing', async () => {
    const { db, testSends } = setup()
    const { fake, triggerSend } = provider(undefined, { ok: false, retryable: true, error: 'Slow down.' })

    await sendCampaignTest(db, 'camp-1', { ...base, provider: fake })

    expect(triggerSend).not.toHaveBeenCalled()
    expect(testSends.argsFor('update')).toEqual([{ outcome: 'failed', error: 'Slow down. Try again in a moment.', provider_reference: null }])
  })

  it('records an ambiguous queue call as uncertain and a refusal as failed', async () => {
    const uncertain = setup()
    await sendCampaignTest(uncertain.db, 'camp-1', { ...base, provider: provider({ ok: false, retryable: false, ambiguous: true, error: 'timeout' }).fake })
    expect(uncertain.testSends.argsFor('update')).toEqual([{ outcome: 'uncertain', error: 'timeout', provider_reference: null }])

    const failed = setup()
    await sendCampaignTest(failed.db, 'camp-1', { ...base, provider: provider({ ok: false, retryable: false, error: 'Contact unsubscribed' }).fake })
    expect(failed.testSends.argsFor('update')).toEqual([{ outcome: 'failed', error: 'Contact unsubscribed', provider_reference: null }])
  })

  it('surfaces an outcome it could not record', async () => {
    const { db } = setup({ settle: { data: null, error: { message: 'denied' } } })
    await expect(sendCampaignTest(db, 'camp-1', { ...base, provider: provider().fake })).rejects.toThrow('denied')
  })

  it('tests a Studio snapshot with its own CTA and no booking link', async () => {
    const snapshot = {
      id: 'snap-1',
      purpose: 'campaign',
      contract_id: 'studio-static-v1',
      contract_version: 1,
      cta_mode: 'none',
      cta_url: null,
      fields: {},
      assets: [],
      content_hash: 'h',
    }
    const campaigns = createQueryBuilderMock({ data: { ...CAMPAIGN, content_snapshot_id: 'snap-1' }, error: null })
    const testSends = createQueryBuilderMock([{ data: { id: 'ts-1' }, error: null }, { data: SETTLED, error: null }])
    const snapshots = createQueryBuilderMock({ data: snapshot, error: null })
    const db = createDbMock((table: string) => ({ campaigns, campaign_test_sends: testSends, campaign_content_snapshots: snapshots })[table])
    const { fake, setContactFields, triggerSend } = provider()

    const outcome = await sendCampaignTest(db as never, 'camp-1', { ...base, provider: fake })

    expect(outcome).toMatchObject({ kind: 'done', note: null })
    expect(setContactFields).not.toHaveBeenCalled()
    expect(triggerSend).toHaveBeenCalledTimes(1)
  })

  it('refuses a Studio snapshot that is not valid content', async () => {
    const campaigns = createQueryBuilderMock({ data: { ...CAMPAIGN, content_snapshot_id: 'snap-1' }, error: null })
    const snapshots = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock((table: string) => (table === 'campaigns' ? campaigns : snapshots))
    expect(await sendCampaignTest(db as never, 'camp-1', { ...base, provider: provider().fake })).toMatchObject({ kind: 'conflict' })
  })
})

describe('reading test sends', () => {
  it('lists the latest and decides whether this revision was tested', async () => {
    const list = createDbMock(createQueryBuilderMock({ data: [SETTLED], error: null }))
    expect(await listTestSends(list as never, 'camp-1')).toEqual([SETTLED])

    const status = (row: unknown) => createDbMock(createQueryBuilderMock({ data: row, error: null })) as never
    expect(await readTestStatus(status({ ...SETTLED, content_hash: null }), { id: 'camp-1', revision: 3 })).toMatchObject({ currentRevisionTested: true })
    expect(await readTestStatus(status({ ...SETTLED, content_hash: null }), { id: 'camp-1', revision: 4 })).toMatchObject({ currentRevisionTested: false })
    expect(await readTestStatus(status({ ...SETTLED, content_hash: 'old' }), { id: 'camp-1', revision: 3 }, 'new')).toMatchObject({ currentRevisionTested: false })
    expect(await readTestStatus(status(null), { id: 'camp-1', revision: 3 })).toEqual({ lastSuccessful: null, currentRevisionTested: false })

    const broken = createDbMock(createQueryBuilderMock({ data: null, error: { message: 'down' } })) as never
    await expect(listTestSends(broken, 'c')).rejects.toThrow('down')
    await expect(readTestStatus(broken, { id: 'c', revision: 1 })).rejects.toThrow('down')
  })
})

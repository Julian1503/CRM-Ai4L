/**
 * @jest-environment node
 *
 * Campaign test sends against the real database (UX plan P0.2): the record is written
 * and settled by the triggers, the rate limit holds, and a test never becomes a
 * delivery — no run, no ledger row, no booking, no change to the campaign.
 */
import { describeIntegration, must, serviceClient, uniqueTag } from '@/test/integration'

import { EMAILOCTOPUS_CAPABILITIES } from './providers/emailOctopus'
import type { CampaignProvider } from './providers/types'
import { readTestStatus, sendCampaignTest, TEST_BOOKING_TOKEN } from './testSend'

jest.setTimeout(60_000)

function fakeProvider() {
  const writes: Array<{ email: string; fields: Record<string, string> }> = []
  const queued: string[] = []
  const provider: CampaignProvider = {
    name: 'fake',
    capabilities: EMAILOCTOPUS_CAPABILITIES,
    setContactFields: async (email, fields) => {
      writes.push({ email, fields })
      return { ok: true, reference: null }
    },
    triggerSend: async ({ email }) => {
      queued.push(email)
      return { ok: true, reference: 'test-ref' }
    },
  }
  return { provider, writes, queued }
}

describeIntegration('campaign test sends against Postgres', () => {
  it('records a settled test of the current revision and never creates a delivery', async () => {
    const db = serviceClient()
    const tag = uniqueTag('testsend')
    const campaign = await must(
      db
        .from('campaigns')
        .insert({ name: tag, provider_automation_id: 'auto-test', consent_stream: 'newsletter', merge_fields: { Headline: 'Hi' } })
        .select('id, revision, status')
        .single()
    )
    const recipient = `${tag}@example.test`
    const fake = fakeProvider()

    const outcome = await sendCampaignTest(db, campaign.id, {
      recipient,
      revision: campaign.revision,
      allowlist: [recipient],
      provider: fake.provider,
      baseUrl: 'https://crm.example.com',
    })

    expect(outcome).toMatchObject({ kind: 'done', testSend: { outcome: 'sent', revision: campaign.revision, recipient } })
    expect(fake.queued).toEqual([recipient])
    expect(fake.writes).toEqual([
      { email: recipient, fields: { Headline: 'Hi', BookingUrl: `https://crm.example.com/book/${TEST_BOOKING_TOKEN}` } },
    ])

    const sends = await db.from('campaign_sends').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id)
    const runs = await db.from('campaign_runs').select('run', { count: 'exact', head: true }).eq('campaign_id', campaign.id)
    const bookings = await db.from('bookings').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id)
    expect([sends.count, runs.count, bookings.count]).toEqual([0, 0, 0])

    const after = await must(db.from('campaigns').select('status, revision, approved_revision').eq('id', campaign.id).single())
    expect(after).toEqual({ status: campaign.status, revision: campaign.revision, approved_revision: null })

    expect(await readTestStatus(db, { id: campaign.id, revision: campaign.revision })).toMatchObject({ currentRevisionTested: true })

    // An edit moves the revision: the last test no longer covers the content.
    await must(db.from('campaigns').update({ merge_fields: { Headline: 'Changed' } }).eq('id', campaign.id).select('id').single())
    expect(await readTestStatus(db, { id: campaign.id, revision: campaign.revision + 1 })).toMatchObject({ currentRevisionTested: false })
  })

  it('refuses a sixth test within the hour', async () => {
    const db = serviceClient()
    const tag = uniqueTag('testsend-limit')
    const campaign = await must(
      db.from('campaigns').insert({ name: tag, provider_automation_id: 'auto-test', consent_stream: 'newsletter', merge_fields: {} }).select('id, revision').single()
    )
    const recipient = `${tag}@example.test`
    const options = { recipient, revision: campaign.revision, allowlist: [recipient], baseUrl: null }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await sendCampaignTest(db, campaign.id, { ...options, provider: fakeProvider().provider })).toMatchObject({ kind: 'done' })
    }
    const sixth = fakeProvider()
    expect(await sendCampaignTest(db, campaign.id, { ...options, provider: sixth.provider })).toMatchObject({ kind: 'rate_limited' })
    expect(sixth.queued).toEqual([])
  })
})

/**
 * @jest-environment node
 *
 * Campaign delivery against the real database (audit H3, H4, H6, H7, T2).
 *
 * These are the acceptance cases the unit tests cannot prove: row locks, lease expiry,
 * PostgREST's response cap, and triggers behave as they do in production only in
 * Postgres. Runs against the local Supabase stack; see src/test/integration.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

import type { CampaignRow, Database } from '@/lib/db/types'
import { describeIntegration, must, serviceClient, uniqueTag, withRpcFaults } from '@/test/integration'

import { advanceCampaignSend } from './dispatch'
import { EMAILOCTOPUS_CAPABILITIES } from './providers/emailOctopus'
import type { CampaignProvider, SendOutcome } from './providers/types'
import { TokenBucket } from './rateLimiter'
import { prepareCampaignRun } from './runs'
import { claimCampaignSends, executeCampaignSends, LedgerWriteError } from './send'

jest.setTimeout(120_000)

type Fixture = { db: SupabaseClient<Database>; organisationId: string; contactIds: string[]; campaign: CampaignRow }

function unlimitedBucket() {
  let now = 0
  return new TokenBucket({ capacity: 1_000_000, refillPerSecond: 1_000_000, now: () => now, sleep: async (ms) => { now += ms } })
}

function recordingProvider(outcome: (email: string) => SendOutcome = () => ({ ok: true, reference: 'ref' })) {
  const sentTo: string[] = []
  const provider: CampaignProvider = {
    name: 'recording',
    capabilities: EMAILOCTOPUS_CAPABILITIES,
    setContactFields: async () => ({ ok: true, reference: null }),
    triggerSend: async ({ email }) => {
      sentTo.push(email)
      // Yield so concurrent workers genuinely interleave.
      await new Promise((resolve) => setTimeout(resolve, 1))
      return outcome(email)
    },
  }
  return { provider, sentTo }
}

async function approver(db: SupabaseClient<Database>): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email: `${uniqueTag('approver')}@example.test`,
    email_confirm: true,
  })
  if (error || !data.user) throw new Error(error?.message ?? 'no user')
  return data.user.id
}

/** An isolated audience: `size` subscribed contacts in their own organisation. */
async function fixture(size: number, status: 'approved' | 'sending' = 'approved'): Promise<Fixture> {
  const db = serviceClient()
  const tag = uniqueTag('delivery')
  const organisation = await must(db.from('organisations').insert({ name: tag }).select('id').single())

  const contactIds: string[] = []
  for (let offset = 0; offset < size; offset += 500) {
    const batch = Array.from({ length: Math.min(500, size - offset) }, (_, index) => ({
      first_name: 'Test',
      last_name: `${tag}-${offset + index}`,
      email: `${tag}-${offset + index}@example.test`,
      organisation_id: organisation.id,
      subscribed_to_newsletter: true,
    }))
    const rows = await must(db.from('contacts').insert(batch).select('id'))
    contactIds.push(...rows.map((row) => row.id))
  }

  const segment = await must(
    db.from('segments').insert({ name: tag, definition: { organisationId: organisation.id } }).select('id').single()
  )
  const created = await must(
    db
      .from('campaigns')
      .insert({ name: tag, segment_id: segment.id, provider_automation_id: 'auto-test', consent_stream: 'newsletter' })
      .select('id')
      .single()
  )
  await must(db.from('campaigns').update({ status: 'in_review' }).eq('id', created.id).select('id'))
  await must(
    db.from('campaigns').update({ status: 'approved', approved_by: await approver(db) }).eq('id', created.id).select('id')
  )

  let campaign = await must(db.from('campaigns').select('*').eq('id', created.id).single())
  if (status === 'sending') {
    await prepareCampaignRun(db, campaign as CampaignRow)
    await must(db.from('campaigns').update({ status: 'sending' }).eq('id', created.id).select('id'))
    campaign = await must(db.from('campaigns').select('*').eq('id', created.id).single())
  }

  return { db, organisationId: organisation.id, contactIds, campaign: campaign as CampaignRow }
}

/** The whole ledger, paged — one request would stop at PostgREST's row cap (H7). */
async function ledger(db: SupabaseClient<Database>, campaignId: string) {
  const rows: Array<{ id: string; contact_id: string; status: string; provider_attempted_at: string | null; error: string | null }> = []
  for (let from = 0; ; from += 500) {
    const page = await must(
      db.from('campaign_sends')
        .select('id, contact_id, status, provider_attempted_at, error')
        .eq('campaign_id', campaignId)
        .order('id')
        .range(from, from + 499)
    )
    rows.push(...page)
    if (page.length === 0) return rows
  }
}

describeIntegration('campaign delivery against Postgres', () => {
  describe('audience preparation (H7)', () => {
    it('materialises an audience larger than the PostgREST row cap, completely', async () => {
      const { db, contactIds, campaign } = await fixture(1_250)

      const run = await prepareCampaignRun(db, campaign)

      expect(run.audience_status).toBe('prepared')
      expect(run.expected_count).toBe(1_250)
      expect(run.prepared_count).toBe(1_250)
      const rows = await ledger(db, campaign.id)
      expect(new Set(rows.map((row) => row.contact_id))).toEqual(new Set(contactIds))
    })

    it('resumes an interrupted preparation without duplicates', async () => {
      const { db, campaign } = await fixture(1_100)
      let pages = 0
      const faulty = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== 'from') return Reflect.get(target, property, receiver)
          return (table: string) => {
            const builder = target.from(table as never)
            if (table !== 'campaign_sends') return builder
            return new Proxy(builder, {
              get(inner, key, innerReceiver) {
                if (key === 'upsert' && ++pages === 2) {
                  return () => Promise.resolve({ data: null, error: { message: 'injected: connection lost' } })
                }
                return Reflect.get(inner, key, innerReceiver)
              },
            })
          }
        },
      }) as SupabaseClient<Database>

      await expect(prepareCampaignRun(faulty, campaign)).rejects.toThrow(/injected/)
      const partial = await must(
        db.from('campaign_runs').select('audience_status, prepared_count').eq('campaign_id', campaign.id).single()
      )
      expect(partial.audience_status).toBe('preparing')
      expect(partial.prepared_count).toBe(500)

      const run = await prepareCampaignRun(db, campaign)

      expect(run.prepared_count).toBe(1_100)
      expect((await ledger(db, campaign.id)).length).toBe(1_100)
    })

    it('refuses to start dispatch before the run is fully prepared', async () => {
      const { db, campaign } = await fixture(3)

      const attempt = await db.from('campaigns').update({ status: 'sending' }).eq('id', campaign.id).select('id')

      expect(attempt.error?.code).toBe('CRM05')
    })
  })

  describe('claims (H3)', () => {
    it('two concurrent workers never send to the same recipient', async () => {
      const { db, campaign } = await fixture(120, 'sending')
      const { provider, sentTo } = recordingProvider()

      const [a, b] = await Promise.all([
        executeCampaignSends(db, provider, campaign, { maxToProcess: 120, bucket: unlimitedBucket() }),
        executeCampaignSends(serviceClient(), provider, campaign, { maxToProcess: 120, bucket: unlimitedBucket() }),
      ])

      expect(sentTo).toHaveLength(120)
      expect(new Set(sentTo).size).toBe(120)
      expect(a.sent + b.sent).toBe(120)
      expect((await ledger(db, campaign.id)).every((row) => row.status === 'sent')).toBe(true)
    })

    it('a provider success whose ledger write fails becomes uncertain, never resent', async () => {
      const { db, campaign } = await fixture(2, 'sending')
      const { provider, sentTo } = recordingProvider()
      const faulty = withRpcFaults(db, (fn, _args, call) =>
        fn === 'complete_campaign_send' && call === 1 ? { message: 'injected: ledger unavailable' } : null
      )

      await expect(
        executeCampaignSends(faulty, provider, campaign, { maxToProcess: 2, bucket: unlimitedBucket(), leaseSeconds: 60 })
      ).rejects.toBeInstanceOf(LedgerWriteError)
      expect(sentTo).toHaveLength(1)

      // The worker "dies"; its lease runs out.
      await must(
        db.from('campaign_sends').update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })
          .eq('campaign_id', campaign.id).eq('status', 'processing').select('id')
      )

      const retry = await executeCampaignSends(db, provider, campaign, { maxToProcess: 10, bucket: unlimitedBucket() })

      const rows = await ledger(db, campaign.id)
      expect(rows.filter((row) => row.status === 'uncertain')).toHaveLength(1)
      // The recipient already emailed is not emailed again.
      expect(new Set(sentTo).size).toBe(sentTo.length)
      expect(retry.sent).toBe(1)
    })

    it('a stale worker cannot record an outcome over a replacement', async () => {
      const { db, campaign } = await fixture(1, 'sending')
      const [stale] = await claimCampaignSends(db, campaign, 1, 60)

      // Its lease expires before it ever reached the provider...
      await must(
        db.from('campaign_sends').update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })
          .eq('id', stale.send_id).select('id')
      )
      // ...so a second worker legitimately takes the recipient over.
      const [fresh] = await claimCampaignSends(db, campaign, 1, 60)
      expect(fresh.send_id).toBe(stale.send_id)
      expect(fresh.claim_token).not.toBe(stale.claim_token)

      const { data: staleWrite } = await db.rpc('complete_campaign_send', {
        p_send_id: stale.send_id,
        p_token: stale.claim_token,
        p_status: 'failed',
        p_error: 'stale',
      })
      expect(staleWrite).toBe(false)

      const { data: freshWrite } = await db.rpc('complete_campaign_send', {
        p_send_id: fresh.send_id,
        p_token: fresh.claim_token,
        p_status: 'sent',
      })
      expect(freshWrite).toBe(true)
    })

    it('a provider timeout is recorded as uncertain and left for a person', async () => {
      const { db, campaign } = await fixture(1, 'sending')
      const { provider } = recordingProvider(() => ({ ok: false, retryable: false, ambiguous: true, error: 'No reply' }))

      await executeCampaignSends(db, provider, campaign, { bucket: unlimitedBucket() })
      const again = await executeCampaignSends(db, provider, campaign, { bucket: unlimitedBucket() })

      expect(again.total).toBe(0)
      expect((await ledger(db, campaign.id))[0].status).toBe('uncertain')
    })
  })

  describe('consent at dispatch (H4)', () => {
    it('suppresses a contact who withdraws after being claimed, and leaves the other stream alone', async () => {
      const { db, contactIds, campaign } = await fixture(2, 'sending')
      const [first] = await claimCampaignSends(db, campaign, 1, 60)

      await must(
        db.from('contacts').update({ subscribed_to_newsletter: false, subscribed_to_programs: true }).eq('id', first.contact_id).select('id')
      )

      const { data: verdict } = await db.rpc('begin_campaign_dispatch', { p_send_id: first.send_id, p_token: first.claim_token })
      expect(verdict).toBe('skipped')

      // The withdrawal also skipped the other recipient? No — only the contact who withdrew.
      const rows = await ledger(db, campaign.id)
      const other = rows.find((row) => row.contact_id !== first.contact_id)
      expect(other?.status).toBe('pending')
      expect(rows.find((row) => row.contact_id === first.contact_id)?.error).toMatch(/newsletter consent/)
      expect(contactIds).toContain(first.contact_id)
    })

    it('skips queued work at once when a contact is archived, without touching sent history', async () => {
      const { db, contactIds, campaign } = await fixture(2, 'sending')
      const { provider } = recordingProvider()
      await executeCampaignSends(db, provider, campaign, { maxToProcess: 1, bucket: unlimitedBucket() })
      const rows = await ledger(db, campaign.id)
      const sent = rows.find((row) => row.status === 'sent')!
      const queued = rows.find((row) => row.status === 'pending')!

      await must(db.from('contacts').update({ deleted_at: new Date().toISOString() }).in('id', contactIds).select('id'))

      const after = await ledger(db, campaign.id)
      expect(after.find((row) => row.id === sent.id)?.status).toBe('sent')
      expect(after.find((row) => row.id === queued.id)).toMatchObject({ status: 'skipped', error: 'The contact is archived.' })
    })
  })

  describe('revisions (H6)', () => {
    it('refuses to send content changed after approval', async () => {
      const { db, campaign } = await fixture(1)

      const edit = await db.from('campaigns').update({ merge_fields: { Headline: 'Changed' } }).eq('id', campaign.id).select('id')
      expect(edit.error?.message).toMatch(/Return this campaign to draft/)
    })

    it('an edited failed campaign returns to draft and loses its approval', async () => {
      const { db, campaign } = await fixture(1, 'sending')
      await must(db.from('campaigns').update({ status: 'failed' }).eq('id', campaign.id).select('id'))

      const edited = await must(
        db.from('campaigns').update({ merge_fields: { Headline: 'Fixed' } }).eq('id', campaign.id).select('*').single()
      )

      expect(edited).toMatchObject({ status: 'draft', approved_revision: null, approved_by: null })
      expect(edited.revision).toBe(campaign.revision + 1)
      // Same audience, same run: the ledger is kept for the retry.
      expect(edited.send_run).toBe(campaign.send_run)
    })

    it('a failed campaign given a different audience starts a new run', async () => {
      const { db, campaign } = await fixture(1, 'sending')
      await must(db.from('campaigns').update({ status: 'failed' }).eq('id', campaign.id).select('id'))
      const other = await must(db.from('segments').insert({ name: uniqueTag('other'), definition: {} }).select('id').single())

      const edited = await must(
        db.from('campaigns').update({ segment_id: other.id }).eq('id', campaign.id).select('*').single()
      )

      expect(edited.send_run).toBe(campaign.send_run + 1)
    })

    it('a retry without edits sends the original approval to exactly who it failed for', async () => {
      const { db, campaign } = await fixture(3)
      const flaky = recordingProvider((email) =>
        email.endsWith('-0@example.test') ? { ok: false, retryable: false, error: 'Rejected' } : { ok: true, reference: 'r' }
      )

      const first = await advanceCampaignSend(db, campaign.id, {
        credentials: { apiKey: 'k', listId: 'l' }, baseUrl: '', chunkSize: 10, provider: flaky.provider,
      })
      expect(first).toMatchObject({ kind: 'progress', status: 'failed' })

      const ok = recordingProvider()
      const retry = await advanceCampaignSend(db, campaign.id, {
        credentials: { apiKey: 'k', listId: 'l' }, baseUrl: '', chunkSize: 10, provider: ok.provider,
      })

      expect(retry).toMatchObject({ kind: 'progress', status: 'sent' })
      expect(ok.sentTo).toHaveLength(1)
      expect(ok.sentTo[0]).toMatch(/-0@example\.test$/)
    })
  })
})

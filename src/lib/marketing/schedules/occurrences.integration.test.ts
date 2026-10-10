/**
 * @jest-environment node
 *
 * Durable newsletter occurrences against the real database (audit H12).
 *
 * The acceptance cases: a failure after the schedule advanced cannot lose the
 * occurrence (it is retried and drafted exactly once), and two schedulers running at
 * once record and draft it once. Runs against the local Supabase stack; see
 * src/test/integration.ts. Each test works on its own fixture schedule only, so other
 * data in the local database is never drafted.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database, NewsletterScheduleRow } from '@/lib/db/types'
import type { NewsletterScheduleOccurrenceRow } from '@/lib/db/scheduleOccurrenceTypes'
import { describeIntegration, must, serviceClient, uniqueTag } from '@/test/integration'

import { claimOccurrences, recordDueOccurrences } from './occurrences'
import { runOccurrence } from './runDue'

jest.setTimeout(120_000)

type Db = SupabaseClient<Database>

async function fixtureSchedule(db: Db): Promise<NewsletterScheduleRow> {
  const tag = uniqueTag('occurrences')
  const segment = await must(db.from('segments').insert({ name: tag }).select('id').single())
  const template = await must(
    db
      .from('campaign_templates')
      .insert({
        name: tag,
        provider_automation_id: `auto-${tag}`,
        slots: [{ tag: 'Headline' }],
        consent_stream: 'newsletter',
      } as never)
      .select('id')
      .single()
  )
  return must(
    db
      .from('newsletter_schedules')
      .insert({
        name: tag,
        template_id: template.id,
        segment_id: segment.id,
        frequency: 'weekly',
        next_run_at: new Date(Date.now() - 60_000).toISOString(),
        goal: 'Integration test',
      } as never)
      .select('*')
      .single()
  ) as Promise<NewsletterScheduleRow>
}

/** Fails reads of one table the first `times` times — a fault at an exact step. */
function failingTable(db: Db, table: string, times: number): Db {
  let remaining = times
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver)
      return (name: string) => {
        if (name === table && remaining > 0) {
          remaining -= 1
          throw new Error(`injected fault reading ${table}`)
        }
        return target.from(name as never)
      }
    },
  })
}

async function occurrencesOf(db: Db, scheduleId: string): Promise<NewsletterScheduleOccurrenceRow[]> {
  const { data, error } = await (db as unknown as SupabaseClient)
    .from('newsletter_schedule_occurrences')
    .select('*')
    .eq('schedule_id', scheduleId)
  if (error) throw new Error(error.message)
  return data as NewsletterScheduleOccurrenceRow[]
}

async function campaignsOf(db: Db, scheduleId: string) {
  return must(db.from('campaigns').select('id, scheduled_for').eq('schedule_id', scheduleId))
}

async function makeDue(db: Db, occurrenceId: string) {
  const { error } = await (db as unknown as SupabaseClient)
    .from('newsletter_schedule_occurrences')
    .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
    .eq('id', occurrenceId)
  if (error) throw new Error(error.message)
}

describeIntegration('newsletter schedule occurrences (H12)', () => {
  const deps = (db: Db) => ({ db, messages: null, now: new Date() })

  beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('a failure after the advance keeps the occurrence; it is retried and drafted exactly once', async () => {
    const db = serviceClient()
    const schedule = await fixtureSchedule(db)

    const recorded = await recordDueOccurrences(db, schedule, new Date())
    expect(recorded).toMatchObject({ outcome: 'recorded' })
    const after = await must(db.from('newsletter_schedules').select('next_run_at').eq('id', schedule.id).single())
    expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(Date.now())

    const [first] = await claimOccurrences(db, { limit: 1, occurrenceId: (recorded as { pendingId: string }).pendingId })
    const failed = await runOccurrence(deps(failingTable(db, 'campaign_templates', 1)), first)
    expect(failed).toMatchObject({ status: 'failed', occurrenceStatus: 'pending' })

    let [occurrence] = await occurrencesOf(db, schedule.id)
    expect(occurrence).toMatchObject({ status: 'pending', attempts: 1 })
    expect(occurrence.last_error).toMatch(/injected fault/)
    expect(await campaignsOf(db, schedule.id)).toHaveLength(0)

    await makeDue(db, occurrence.id)
    const [second] = await claimOccurrences(db, { limit: 1, occurrenceId: occurrence.id })
    const drafted = await runOccurrence(deps(db), second)
    expect(drafted).toMatchObject({ status: 'needs_attention' })

    ;[occurrence] = await occurrencesOf(db, schedule.id)
    expect(occurrence).toMatchObject({ status: 'drafted', attempts: 2 })
    const campaigns = await campaignsOf(db, schedule.id)
    expect(campaigns).toHaveLength(1)
    expect(occurrence.campaign_id).toBe(campaigns[0].id)

    // Nothing left to claim, and a replayed draft for the same date finds the campaign.
    expect(await claimOccurrences(db, { limit: 1, occurrenceId: occurrence.id })).toEqual([])
  })

  it('a failure after the campaign was created resumes that campaign instead of making a second', async () => {
    const db = serviceClient()
    const schedule = await fixtureSchedule(db)
    const recorded = (await recordDueOccurrences(db, schedule, new Date())) as { pendingId: string }

    const [first] = await claimOccurrences(db, { limit: 1, occurrenceId: recorded.pendingId })
    const failed = await runOccurrence(deps(failingTable(db, 'newsletter_topics', 1)), first)
    expect(failed).toMatchObject({ status: 'failed', occurrenceStatus: 'pending' })
    expect(await campaignsOf(db, schedule.id)).toHaveLength(1)

    await makeDue(db, recorded.pendingId)
    const [second] = await claimOccurrences(db, { limit: 1, occurrenceId: recorded.pendingId })
    await runOccurrence(deps(db), second)

    expect(await campaignsOf(db, schedule.id)).toHaveLength(1)
    const [occurrence] = await occurrencesOf(db, schedule.id)
    expect(occurrence.status).toBe('drafted')
  })

  it('two schedulers at once record the occurrence once and draft it once', async () => {
    const db = serviceClient()
    const other = serviceClient()
    const schedule = await fixtureSchedule(db)

    const outcomes = await Promise.all([
      recordDueOccurrences(db, schedule, new Date()),
      recordDueOccurrences(other, schedule, new Date()),
    ])
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['claimed_elsewhere', 'recorded'])

    const [occurrence] = await occurrencesOf(db, schedule.id)
    const claims = await Promise.all([
      claimOccurrences(db, { limit: 1, occurrenceId: occurrence.id }),
      claimOccurrences(other, { limit: 1, occurrenceId: occurrence.id }),
    ])
    const winners = claims.flat()
    expect(winners).toHaveLength(1)

    await Promise.all([runOccurrence(deps(db), winners[0])])
    expect(await campaignsOf(db, schedule.id)).toHaveLength(1)
    expect((await occurrencesOf(db, schedule.id))[0].status).toBe('drafted')
  })

  it('catch-up after downtime drafts only the most recent occurrence and records the rest as skipped', async () => {
    const db = serviceClient()
    const schedule = await fixtureSchedule(db)
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000 - 60_000).toISOString()
    await must(db.from('newsletter_schedules').update({ next_run_at: threeWeeksAgo }).eq('id', schedule.id).select('id'))

    const recorded = await recordDueOccurrences(db, { ...schedule, next_run_at: threeWeeksAgo }, new Date())
    expect(recorded).toMatchObject({ outcome: 'recorded', skipped: 3 })

    const rows = await occurrencesOf(db, schedule.id)
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1)
    expect(rows.filter((row) => row.status === 'skipped').every((row) => Boolean(row.skip_reason))).toBe(true)
  })
})

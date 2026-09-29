/**
 * @jest-environment node
 *
 * Consent outbox against the real database (audit H5, T2).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import { describeIntegration, must, serviceClient, uniqueTag } from '@/test/integration'

import { processConsentOutbox } from './outbox'

jest.setTimeout(60_000)

type Pushed = { contactId: string; newsletter: boolean; programs: boolean; version: number }

function recorder(fail = false) {
  const pushed: Pushed[] = []
  return {
    pushed,
    push: async (state: { contact_id: string; newsletter: boolean; programs: boolean; state_version: number }) => {
      if (fail) throw new Error('injected: provider unavailable')
      pushed.push({ contactId: state.contact_id, newsletter: state.newsletter, programs: state.programs, version: state.state_version })
    },
  }
}

async function contact(db: SupabaseClient<Database>, subscribed = true) {
  const tag = uniqueTag('consent')
  return must(
    db.from('contacts')
      .insert({ first_name: 'C', last_name: tag, email: `${tag}@example.test`, subscribed_to_newsletter: subscribed })
      .select('id, consent_version')
      .single()
  )
}

async function outbox(db: SupabaseClient<Database>, contactId: string) {
  return must(
    db.from('consent_sync_outbox').select('status, consent_version, attempts, last_error').eq('contact_id', contactId).order('consent_version')
  )
}

async function drain(db: SupabaseClient<Database>, contactId: string, push: ReturnType<typeof recorder>['push']) {
  return processConsentOutbox(db, { credentials: null, origin: null, contactId, push: push as never })
}

describeIntegration('consent outbox against Postgres', () => {
  it('queues a withdrawal in the same transaction as the change', async () => {
    const db = serviceClient()
    const { id } = await contact(db)

    await db.rpc('apply_contact_consent', { p_contact_id: id, p_newsletter: false, p_programs: null, p_source: 'preference_center' })

    const rows = await outbox(db, id)
    expect(rows.at(-1)).toMatchObject({ status: 'pending' })
  })

  it('still synchronises a contact that the withdrawal archived', async () => {
    const db = serviceClient()
    const { id } = await contact(db)
    await db.rpc('apply_contact_consent', { p_contact_id: id, p_newsletter: false, p_programs: false, p_source: 'preference_center' })
    const archived = await must(db.from('contacts').select('deleted_at').eq('id', id).single())
    const { pushed, push } = recorder()

    await drain(db, id, push)

    // Lifecycle rule 2: leaving the active views must not stop suppression.
    expect(archived.deleted_at).not.toBeNull()
    expect(pushed).toEqual([expect.objectContaining({ contactId: id, newsletter: false, programs: false })])
  })

  it('converges on the latest state; a replay of an old change cannot re-subscribe', async () => {
    const db = serviceClient()
    const { id } = await contact(db)
    await db.rpc('apply_contact_consent', { p_contact_id: id, p_newsletter: false, p_programs: null, p_source: 'test' })
    await db.rpc('apply_contact_consent', { p_contact_id: id, p_newsletter: true, p_programs: null, p_source: 'test' })
    await db.rpc('apply_contact_consent', { p_contact_id: id, p_newsletter: false, p_programs: null, p_source: 'test' })
    const { pushed, push } = recorder()

    await drain(db, id, push)
    await drain(db, id, push)

    // One push, of the final state; every older entry settled by it.
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatchObject({ newsletter: false })
    expect((await outbox(db, id)).every((row) => ['done', 'superseded'].includes(row.status))).toBe(true)
  })

  it('keeps a failed push queued with backoff, and recovers on retry', async () => {
    const db = serviceClient()
    const { id } = await contact(db)
    await db.rpc('apply_contact_consent', { p_contact_id: id, p_newsletter: false, p_programs: null, p_source: 'test' })

    const failing = recorder(true)
    const first = await drain(db, id, failing.push)
    expect(first.failed).toBe(1)
    const afterFailure = (await outbox(db, id)).at(-1)!
    expect(afterFailure).toMatchObject({ status: 'pending', attempts: 1, last_error: 'injected: provider unavailable' })

    // Not due yet: backoff holds it.
    const working = recorder()
    await drain(db, id, working.push)
    expect(working.pushed).toHaveLength(0)

    await must(db.from('consent_sync_outbox').update({ next_attempt_at: new Date(0).toISOString() }).eq('contact_id', id).select('id'))
    await drain(db, id, working.push)
    expect(working.pushed).toHaveLength(1)
  })

  it('does not enqueue a write that changes nothing, so a provider echo cannot loop', async () => {
    const db = serviceClient()
    const { id, consent_version } = await contact(db)
    const before = (await outbox(db, id)).length

    await db.rpc('apply_contact_consent', { p_contact_id: id, p_newsletter: true, p_programs: null, p_source: 'newsletter_webhook' })

    expect((await outbox(db, id)).length).toBe(before)
    expect((await must(db.from('contacts').select('consent_version').eq('id', id).single())).consent_version).toBe(consent_version)
  })
})

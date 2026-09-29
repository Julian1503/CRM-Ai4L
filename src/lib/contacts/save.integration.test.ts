/**
 * @jest-environment node
 *
 * Contact saves against the real database (audit H8, T2).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import { describeIntegration, must, serviceClient, uniqueTag } from '@/test/integration'

import { saveContact, type ContactSaveInput, type SaveContactResult } from './save'

type Saved = { id: string; revision: number; last_name: string; organisation: { name: string } }

function saved(result: SaveContactResult): Saved {
  if (result.kind !== 'saved') throw new Error(`Expected a save, got ${result.kind}`)
  return result.contact as unknown as Saved
}

jest.setTimeout(60_000)

async function services(db: SupabaseClient<Database>, count: number): Promise<string[]> {
  const rows = await must(
    db.from('services').insert(Array.from({ length: count }, (_, index) => ({ name: uniqueTag(`svc${index}`) }))).select('id')
  )
  return rows.map((row) => row.id)
}

async function links(db: SupabaseClient<Database>, contactId: string): Promise<string[]> {
  const rows = await must(db.from('contact_services').select('service_id').eq('contact_id', contactId))
  return rows.map((row) => row.service_id).sort()
}

function input(overrides: Partial<ContactSaveInput> = {}): ContactSaveInput {
  const tag = uniqueTag('save')
  return { firstName: 'Ada', lastName: tag, email: `${tag}@example.test`, status: 'customer', ...overrides }
}

describeIntegration('save_contact against Postgres', () => {
  it('creates a contact with organisation and services together', async () => {
    const db = serviceClient()
    const [a, b] = await services(db, 2)
    const org = uniqueTag('Org')

    const result = await saveContact(db, { id: null, input: input({ organisationName: org, servicesBought: [a, b] }), expectedRevision: null })

    expect(result.kind).toBe('saved')
    const contact = saved(result)
    expect(contact.organisation.name).toBe(org)
    expect(await links(db, contact.id)).toEqual([a, b].sort())
  })

  it('an invalid service id changes nothing, and does not drop the existing links', async () => {
    const db = serviceClient()
    const [a] = await services(db, 1)
    const created = await saveContact(db, { id: null, input: input({ servicesBought: [a] }), expectedRevision: null })
    const contact = saved(created)

    const result = await saveContact(db, {
      id: contact.id,
      input: input({ lastName: 'Renamed', servicesBought: ['00000000-0000-4000-8000-000000000000'] }),
      expectedRevision: contact.revision,
    })

    expect(result.kind).toBe('invalid')
    expect(await links(db, contact.id)).toEqual([a])
    const after = await must(db.from('contacts').select('last_name, revision').eq('id', contact.id).single())
    expect(after).toEqual({ last_name: contact.last_name, revision: contact.revision })
  })

  it('refuses to overwrite an edit it did not see', async () => {
    const db = serviceClient()
    const created = await saveContact(db, { id: null, input: input(), expectedRevision: null })
    const contact = saved(created)

    const first = await saveContact(db, { id: contact.id, input: input({ notes: 'first editor' }), expectedRevision: contact.revision })
    const second = await saveContact(db, { id: contact.id, input: input({ notes: 'second editor' }), expectedRevision: contact.revision })

    expect(first.kind).toBe('saved')
    expect(second.kind).toBe('conflict')
    expect((await must(db.from('contacts').select('notes').eq('id', contact.id).single())).notes).toBe('first editor')
  })

  it('matches an organisation the way its unique index does', async () => {
    const db = serviceClient()
    const name = uniqueTag('Acme Pty')
    await saveContact(db, { id: null, input: input({ organisationName: name }), expectedRevision: null })

    const again = await saveContact(db, { id: null, input: input({ organisationName: `  ${name.toUpperCase()} ` }), expectedRevision: null })

    expect(again.kind).toBe('saved')
    const matches = await must(db.from('organisations').select('id').ilike('name', name))
    expect(matches).toHaveLength(1)
  })

  it('records an operator consent change and queues it for the provider', async () => {
    const db = serviceClient()
    const created = await saveContact(db, { id: null, input: input({ subscribedToNewsletter: true }), expectedRevision: null })
    const contact = saved(created)

    await saveContact(db, { id: contact.id, input: input({ subscribedToNewsletter: false }), expectedRevision: contact.revision })

    const events = await must(db.from('contact_consent_events').select('source, granted').eq('contact_id', contact.id).order('occurred_at'))
    expect(events.at(-1)).toMatchObject({ source: 'crm_operator', granted: false })
    const queued = await must(db.from('consent_sync_outbox').select('status').eq('contact_id', contact.id))
    expect(queued.length).toBeGreaterThan(0)
  })
})

/**
 * @jest-environment node
 *
 * Contact tags and the tag / organisation / industry filters against the real database
 * and PostgREST. The unit tests can only check the query that would be sent; these
 * check what PostgREST does with it, in particular that a contact matching several
 * selected tags comes back once and is counted once.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import { describeIntegration, must, serviceClient, uniqueTag } from '@/test/integration'

import { parseContactFilters } from './query'
import { fetchContacts } from './repository'
import { saveContact, type SaveContactResult } from './save'
import { applyContactTags, createTag } from './tagRepository'

jest.setTimeout(60_000)

async function newTag(db: SupabaseClient<Database>, label: string): Promise<string> {
  const result = await createTag(db, uniqueTag(label))
  if (result.kind !== 'ok') throw new Error(result.message)
  return result.tag.id
}

async function newContact(db: SupabaseClient<Database>, organisationName?: string): Promise<{ id: string; revision: number }> {
  const tag = uniqueTag('tagged')
  const result: SaveContactResult = await saveContact(db, {
    id: null,
    input: { firstName: 'Ada', lastName: tag, email: `${tag}@example.test`, organisationName },
    expectedRevision: null,
  })
  if (result.kind !== 'saved') throw new Error(`Expected a save, got ${result.kind}`)
  return { id: String(result.contact.id), revision: Number(result.contact.revision) }
}

describeIntegration('contact tags against Postgres and PostgREST', () => {
  it('returns a contact matching two selected tags once, with an exact count', async () => {
    const db = serviceClient()
    const [a, b] = [await newTag(db, 'A'), await newTag(db, 'B')]
    const both = await newContact(db)
    const onlyA = await newContact(db)
    await applyContactTags(db, { contactIds: [both.id, onlyA.id], tagIds: [a], operation: 'add' })
    await applyContactTags(db, { contactIds: [both.id], tagIds: [b], operation: 'add' })

    const page = await fetchContacts(db, parseContactFilters({ tagIds: `${a},${b}`, pageSize: '200' }))

    expect(page.rows.map((row) => row.id).sort()).toEqual([both.id, onlyA.id].sort())
    expect(page.total).toBe(2)
    // The display embed still carries every tag of the contact, not just the matched ones.
    expect(page.rows.find((row) => row.id === both.id)?.tags.map((tag) => tag.id).sort()).toEqual([a, b].sort())
  })

  it('moves the revision only when the tag set changes', async () => {
    const db = serviceClient()
    const tag = await newTag(db, 'Rev')
    const contact = await newContact(db)

    const first = await applyContactTags(db, { contactIds: [contact.id], tagIds: [tag], operation: 'add' })
    const again = await applyContactTags(db, { contactIds: [contact.id], tagIds: [tag], operation: 'add' })

    expect(first).toEqual({ kind: 'applied', updated: 1 })
    expect(again).toEqual({ kind: 'applied', updated: 0 })
    const after = await must(db.from('contacts').select('revision').eq('id', contact.id).single())
    expect(after.revision).toBe(contact.revision + 1)
  })

  it('refuses a stale selection as a whole', async () => {
    const db = serviceClient()
    const tag = await newTag(db, 'Stale')
    const live = await newContact(db)

    const result = await applyContactTags(db, {
      contactIds: [live.id, '00000000-0000-4000-8000-000000000000'],
      tagIds: [tag],
      operation: 'add',
    })

    expect(result.kind).toBe('stale')
    expect(await must(db.from('contact_tags').select('tag_id').eq('contact_id', live.id))).toEqual([])
  })

  it('filters by organisation and by industry ignoring case and outer spaces', async () => {
    const db = serviceClient()
    const orgName = uniqueTag('Org')
    const industry = uniqueTag('Health')
    const contact = await newContact(db, orgName)
    await must(db.from('organisations').update({ industry: ` ${industry.toUpperCase()} ` }).ilike('name', orgName).select('id'))
    const org = await must(db.from('organisations').select('id').ilike('name', orgName).single())

    const byIndustry = await fetchContacts(db, parseContactFilters({ industry: industry.toLowerCase() }))
    const byOrganisation = await fetchContacts(db, parseContactFilters({ organisationId: org.id }))

    expect(byIndustry.rows.map((row) => row.id)).toEqual([contact.id])
    expect(byIndustry.total).toBe(1)
    expect(byOrganisation.rows.map((row) => row.id)).toEqual([contact.id])
  })
})

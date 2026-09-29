import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

import {
  SEGMENT_MEMBER_CAP,
  resolveSegmentAudience,
  measureSegmentAudience,
} from './segments'

const CONTACTS = [
  { id: 'c1', email: 'a@example.com', first_name: 'A', last_name: 'One', is_included: false },
  { id: 'c2', email: 'b@example.com', first_name: 'B', last_name: 'Two', is_included: true },
]

function setup(
  response: unknown = { data: CONTACTS, error: null, count: CONTACTS.length },
  organisations: unknown = { data: [], error: null }
) {
  const contacts = createQueryBuilderMock(response)
  const orgs = createQueryBuilderMock(organisations)
  const db = createDbMock(() => orgs)

  db.rpc = jest.fn(() => contacts) as never

  return { db, contacts, orgs }
}

function orArgs(builder: QueryBuilderMock): string[] {
  return builder.allFor('or').map((call) => call.args[0] as string)
}

describe('resolveSegmentAudience', () => {
  const base = {
    segmentId: 'seg-1',
    definition: { state: 'NSW' },
    stream: 'newsletter' as const,
    page: 1,
    pageSize: 25,
  }

  it('reads the segment’s candidates, which already leave its exclusions out', async () => {
    const { db } = setup()

    await resolveSegmentAudience(db as never, base)

    expect(db.rpc).toHaveBeenCalledWith(
      'segment_contacts',
      { p_segment_id: 'seg-1' },
      { count: 'exact' }
    )
  })

  it('calls rpc on the client, which supabase-js needs as `this`', async () => {
    const { db, contacts } = setup()
    // Mirrors supabase-js: rpc reads `this.rest`, so a detached call throws.
    db.rpc = jest.fn(function (this: unknown) {
      if (this !== db) throw new TypeError("Cannot read properties of undefined (reading 'rest')")
      return contacts
    }) as never

    await expect(resolveSegmentAudience(db as never, base)).resolves.toBeDefined()
  })

  it('previews an unsaved definition with no overrides', async () => {
    const { db } = setup()

    await resolveSegmentAudience(db as never, { ...base, segmentId: null })

    expect((db.rpc as jest.Mock).mock.calls[0][1]).toEqual({ p_segment_id: null })
  })

  it('always requires consent for the stream being sent, outside the criteria', async () => {
    const { db, contacts } = setup()

    await resolveSegmentAudience(db as never, { ...base, stream: 'programs' })

    expect(contacts.allFor('eq').map((call) => call.args)).toContainEqual([
      'subscribed_to_programs',
      true,
    ])
  })

  it('lets a manual inclusion satisfy the criteria, and nothing else', async () => {
    const { db, contacts } = setup()

    await resolveSegmentAudience(db as never, base)

    expect(orArgs(contacts)).toEqual(['is_included.is.true,and(state.eq."NSW")'])
  })

  it('applies no criteria filter when the segment has none', async () => {
    const { db, contacts } = setup()

    await resolveSegmentAudience(db as never, { ...base, definition: {} })

    expect(orArgs(contacts)).toEqual([])
  })

  it('narrows further by a search, as a separate condition', async () => {
    const { db, contacts } = setup()

    await resolveSegmentAudience(db as never, { ...base, search: 'ada' })

    const [criteria, search] = orArgs(contacts)
    expect(criteria.startsWith('is_included.is.true,')).toBe(true)
    expect(search).toContain('first_name.ilike."%ada%"')
  })

  it('expands a free-text criterion to matching organisations', async () => {
    const { db, contacts } = setup(undefined, { data: [{ id: 'org-7' }], error: null })

    await resolveSegmentAudience(db as never, { ...base, definition: { q: 'acme' } })

    expect(orArgs(contacts)[0]).toContain('organisation_id.in.(org-7)')
  })

  it('pages in a stable order', async () => {
    const { db, contacts } = setup()

    await resolveSegmentAudience(db as never, { ...base, page: 3, pageSize: 25 })

    expect(contacts.allFor('order').map((call) => call.args[0])).toEqual(['last_name', 'id'])
    expect(contacts.argsFor('range')).toEqual([50, 74])
  })

  it('reports which members were added by hand', async () => {
    const { db } = setup()

    const page = await resolveSegmentAudience(db as never, base)

    expect(page.members.map((member) => member.is_included)).toEqual([false, true])
    expect(page).toMatchObject({ total: 2, truncated: false, page: 1, pageSize: 25 })
  })

  it('surfaces a query failure', async () => {
    const { db } = setup({ data: null, error: { message: 'boom' }, count: null })

    await expect(resolveSegmentAudience(db as never, base)).rejects.toThrow(/boom/)
  })
})

describe('measureSegmentAudience', () => {
  const segment = { id: 'seg-1', definition: {} }

  it('counts without reading the audience, which a row cap would truncate (audit H7)', async () => {
    const { db, contacts } = setup({ data: CONTACTS, error: null, count: 12_345 })

    const result = await measureSegmentAudience(db as never, segment, 'newsletter')

    expect(contacts.argsFor('range')).toEqual([0, 0])
    expect(result).toEqual({ total: 12_345, truncated: true })
  })

  it('reports when the cap truncated the segment', async () => {
    // Silently sending to the first N of a larger segment would look like a
    // successful full send.
    const { db } = setup({ data: CONTACTS, error: null, count: SEGMENT_MEMBER_CAP + 500 })

    expect((await measureSegmentAudience(db as never, segment, 'newsletter')).truncated).toBe(true)
  })

  it('honours the segment’s overrides, because it reads through its id', async () => {
    const { db } = setup()

    await measureSegmentAudience(db as never, segment, 'newsletter')

    expect((db.rpc as jest.Mock).mock.calls[0][1]).toEqual({ p_segment_id: 'seg-1' })
  })
})

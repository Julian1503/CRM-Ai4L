import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import {
  SEGMENT_MEMBER_CAP,
  filtersToSegmentDefinition,
  resolveSegmentMembers,
  segmentDefinitionToFilters,
} from './segments'

describe('segmentDefinitionToFilters', () => {
  it('reads a stored definition', () => {
    const filters = segmentDefinitionToFilters(
      { state: 'NSW', status: 'lead', jobTypeId: 'job-1' },
      'newsletter'
    )

    expect(filters).toMatchObject({ state: 'NSW', status: 'lead', jobTypeId: 'job-1' })
  })

  it('only ever targets contacts who consented to the stream being sent', () => {
    // Marketing to contacts who never opted in is the Spam Act exposure flagged in
    // PLAN.md. A segment cannot be defined to include them, whatever the stored JSON
    // says.
    expect(segmentDefinitionToFilters({ subscribed: 'false' }, 'newsletter').subscribed).toBe(true)
    expect(segmentDefinitionToFilters({}, 'newsletter').subscribed).toBe(true)

    const programs = segmentDefinitionToFilters({ subscribed: 'false' }, 'programs')
    expect(programs.subscribedToPrograms).toBe(true)
  })

  it('gates on the stream being sent and leaves the other unfiltered', () => {
    // A contact who takes courses but not the newsletter is a legitimate recipient of a
    // course campaign. Requiring both consents would silently shrink every audience to
    // the intersection.
    const programs = segmentDefinitionToFilters({}, 'programs')
    expect(programs.subscribed).toBeNull()

    const newsletter = segmentDefinitionToFilters({}, 'newsletter')
    expect(newsletter.subscribedToPrograms).toBeNull()
  })

  it('never includes archived contacts', () => {
    expect(segmentDefinitionToFilters({ includeArchived: 'true' }, 'newsletter').includeArchived).toBe(false)
  })

  it('discards an unknown status rather than passing it through', () => {
    expect(segmentDefinitionToFilters({ status: 'vip' }, 'newsletter').status).toBeNull()
  })

  it('discards an unknown sort key', () => {
    expect(segmentDefinitionToFilters({ sort: 'password' }, 'newsletter').sort).toBe('name')
  })

  it.each([null, undefined, 'a string', 42, []])(
    'falls back to safe defaults for %p',
    (definition) => {
      const filters = segmentDefinitionToFilters(definition, 'newsletter')

      expect(filters.subscribed).toBe(true)
      expect(filters.includeArchived).toBe(false)
      expect(filters.status).toBeNull()
    }
  )

  it('ignores a definition trying to raise the member cap', () => {
    // A hand-edited row must not be able to produce an unbounded query.
    expect(
      segmentDefinitionToFilters({ pageSize: '999999' }, 'newsletter').pageSize
    ).toBeLessThanOrEqual(SEGMENT_MEMBER_CAP)
  })
})

describe('filtersToSegmentDefinition', () => {
  it('round-trips through storage', () => {
    const original = segmentDefinitionToFilters({ state: 'VIC', jobTypeId: 'job-2' }, 'newsletter')
    const stored = filtersToSegmentDefinition(original)
    const reparsed = segmentDefinitionToFilters(stored, 'newsletter')

    expect(reparsed).toEqual(original)
  })

  it('stores a plain JSON-serialisable object', () => {
    const stored = filtersToSegmentDefinition(segmentDefinitionToFilters({ state: 'QLD' }, 'newsletter'))

    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored)
  })

  it('does not persist pagination, which is not part of a segment', () => {
    const stored = filtersToSegmentDefinition(segmentDefinitionToFilters({ page: '4' }, 'newsletter'))

    expect(stored).not.toHaveProperty('page')
    expect(stored).not.toHaveProperty('pageSize')
  })
})

describe('resolveSegmentMembers', () => {
  const contacts = [
    { id: 'c1', email: 'a@example.com', first_name: 'A', last_name: 'One' },
    { id: 'c2', email: 'b@example.com', first_name: 'B', last_name: 'Two' },
  ]

  function setup(rows: unknown[] = contacts, count = rows.length) {
    const builder = createQueryBuilderMock({ data: rows, error: null, count })
    return { builder, db: createDbMock(builder) }
  }

  it('returns the matching contacts', async () => {
    const { db } = setup()

    const result = await resolveSegmentMembers(db as never, { state: 'NSW' }, 'newsletter')

    expect(result.members).toHaveLength(2)
    expect(result.total).toBe(2)
  })

  it('reads through the active_contacts view', async () => {
    const { db } = setup()

    await resolveSegmentMembers(db as never, {}, 'newsletter')

    expect(db.from).toHaveBeenCalledWith('active_contacts')
  })

  it('filters to subscribed contacts at the query level', async () => {
    const { builder } = setup()
    const db = createDbMock(builder)

    await resolveSegmentMembers(db as never, { subscribed: 'false' }, 'newsletter')

    expect(builder.allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['subscribed_to_newsletter', true],
    })
  })

  it('caps the result set', async () => {
    const { builder } = setup()
    const db = createDbMock(builder)

    await resolveSegmentMembers(db as never, {}, 'newsletter')

    const range = builder.argsFor('range') as [number, number]
    expect(range[1]).toBe(SEGMENT_MEMBER_CAP - 1)
  })

  it('reports when the cap truncated the segment', async () => {
    // Silently sending to the first N of a larger segment would look like a
    // successful full send.
    const { db } = setup(contacts, SEGMENT_MEMBER_CAP + 500)

    const result = await resolveSegmentMembers(db as never, {}, 'newsletter')

    expect(result.truncated).toBe(true)
  })

  it('is not truncated when everything fits', async () => {
    const { db } = setup()

    expect((await resolveSegmentMembers(db as never, {}, 'newsletter')).truncated).toBe(false)
  })

  it('surfaces a query failure', async () => {
    const builder = createQueryBuilderMock({ data: null, error: { message: 'boom' }, count: null })

    await expect(
      resolveSegmentMembers(createDbMock(builder) as never, {}, 'newsletter')
    ).rejects.toThrow(/boom/)
  })
})

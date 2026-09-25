import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { computeSegmentFacets, resolveSegmentFacets, type FacetRow } from './facets'
import { SEGMENT_MEMBER_CAP, segmentDefinitionToFilters } from './segments'

/**
 * Nine subscribed contacts: 5 in NSW (3 electricians, 2 plumbers), 3 in VIC
 * (1 electrician, 2 plumbers) and 1 with neither state nor job type.
 */
const ROWS: FacetRow[] = [
  { state: 'NSW', job_type_id: 'elec', status: 'lead' },
  { state: 'NSW', job_type_id: 'elec', status: 'lead' },
  { state: 'NSW', job_type_id: 'elec', status: 'customer' },
  { state: 'NSW', job_type_id: 'plumb', status: 'lead' },
  { state: 'NSW', job_type_id: 'plumb', status: 'prospect' },
  { state: 'VIC', job_type_id: 'elec', status: 'lead' },
  { state: 'VIC', job_type_id: 'plumb', status: 'customer' },
  { state: 'VIC', job_type_id: 'plumb', status: 'customer' },
  { state: null, job_type_id: null, status: 'lead' },
]

const filtersFor = (definition: Record<string, string>) =>
  segmentDefinitionToFilters(definition, 'newsletter')

describe('computeSegmentFacets', () => {
  it('counts every option when nothing is selected', () => {
    const facets = computeSegmentFacets(ROWS, filtersFor({}))

    expect(facets.state).toEqual({ '': 9, NSW: 5, VIC: 3 })
    expect(facets.jobType).toEqual({ '': 9, elec: 4, plumb: 4 })
    expect(facets.status).toEqual({ '': 9, lead: 5, prospect: 1, customer: 3 })
  })

  it('narrows the other lists to the selected state', () => {
    // The point of the numbers: with NSW chosen, the job-type list says how many of
    // those 5 contacts each trade would leave you with.
    const facets = computeSegmentFacets(ROWS, filtersFor({ state: 'NSW' }))

    expect(facets.jobType).toEqual({ '': 5, elec: 3, plumb: 2 })
    expect(facets.status).toEqual({ '': 5, lead: 3, prospect: 1, customer: 1 })
  })

  it('counts a list against every option *except* its own selection', () => {
    // A dimension filtered by itself would report its own value and zero everywhere
    // else, which says nothing about what switching to VIC would give you.
    const facets = computeSegmentFacets(ROWS, filtersFor({ state: 'NSW' }))

    expect(facets.state).toEqual({ '': 9, NSW: 5, VIC: 3 })
  })

  it('combines two selections when counting the third list', () => {
    const facets = computeSegmentFacets(ROWS, filtersFor({ state: 'NSW', status: 'lead' }))

    expect(facets.jobType).toEqual({ '': 3, elec: 2, plumb: 1 })
  })

  it('counts a contact with no state or job type only in the totals', () => {
    // Otherwise the "Any" option and the sum of the options disagree, and the row
    // looks lost rather than merely unclassified.
    const facets = computeSegmentFacets(ROWS, filtersFor({}))

    expect(facets.state['']).toBe(9)
    expect(facets.state.NSW + facets.state.VIC).toBe(8)
  })

  it('omits an option no contact matches rather than inventing a zero', () => {
    const facets = computeSegmentFacets(ROWS, filtersFor({ state: 'QLD' }))

    expect(facets.jobType).toEqual({ '': 0 })
    expect(facets.state.QLD).toBeUndefined()
  })

  it('returns empty counts for an empty audience', () => {
    const facets = computeSegmentFacets([], filtersFor({}))

    expect(facets).toEqual({ state: { '': 0 }, jobType: { '': 0 }, status: { '': 0 } })
  })
})

describe('resolveSegmentFacets', () => {
  function setup(rows: FacetRow[] = ROWS, count = rows.length) {
    const builder = createQueryBuilderMock({ data: rows, error: null, count })
    return { builder, db: createDbMock(builder) }
  }

  it('counts through the active_contacts view', async () => {
    const { db } = setup()

    await resolveSegmentFacets(db as never, {}, 'newsletter')

    expect(db.from).toHaveBeenCalledWith('active_contacts')
  })

  it('reads only the three columns the builder filters on', async () => {
    const { builder, db } = setup()

    await resolveSegmentFacets(db as never, {}, 'newsletter')

    expect(builder.argsFor('select')?.[0]).toBe('state, job_type_id, status')
  })

  it('applies the segment invariants but not the facet filters', async () => {
    // The three filtered columns are counted in memory, so sending them to Postgres
    // would return exactly the rows the counts must look past.
    const { builder, db } = setup()

    await resolveSegmentFacets(db as never, { state: 'NSW', status: 'lead', jobTypeId: 'elec' }, 'newsletter')

    const columns = builder.allFor('eq').map((call) => call.args[0])
    expect(columns).toContain('subscribed_to_newsletter')
    expect(columns).not.toContain('state')
    expect(columns).not.toContain('status')
    expect(columns).not.toContain('job_type_id')
  })

  it('counts against the filters the definition asked for', async () => {
    const { db } = setup()

    const facets = await resolveSegmentFacets(db as never, { state: 'NSW' }, 'newsletter')

    expect(facets.jobType).toEqual({ '': 5, elec: 3, plumb: 2 })
  })

  it('caps the rows it reads', async () => {
    const { builder, db } = setup()

    await resolveSegmentFacets(db as never, {}, 'newsletter')

    expect((builder.argsFor('range') as [number, number])[1]).toBe(SEGMENT_MEMBER_CAP - 1)
  })

  it('reports counts as truncated once past the cap', async () => {
    // Past the cap the numbers describe the first N contacts, not the audience.
    const { db } = setup(ROWS, SEGMENT_MEMBER_CAP + 1)

    expect((await resolveSegmentFacets(db as never, {}, 'newsletter')).truncated).toBe(true)
  })

  it('is not truncated when the audience fits', async () => {
    const { db } = setup()

    expect((await resolveSegmentFacets(db as never, {}, 'newsletter')).truncated).toBe(false)
  })

  it('surfaces a query failure', async () => {
    const builder = createQueryBuilderMock({ data: null, error: { message: 'boom' }, count: null })

    await expect(resolveSegmentFacets(createDbMock(builder) as never, {}, 'newsletter')).rejects.toThrow(/boom/)
  })
})

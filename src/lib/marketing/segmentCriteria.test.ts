import {
  EMPTY_CRITERIA,
  buildSegmentFilterExpression,
  criteriaToDefinition,
  parseSegmentCriteria,
} from './segmentCriteria'

describe('parseSegmentCriteria', () => {
  it('reads every supported criterion', () => {
    expect(
      parseSegmentCriteria({
        q: ' acme ',
        state: 'NSW',
        jobTypeId: 'job-1',
        status: 'lead',
        organisationId: 'org-1',
        serviceId: 'svc-1',
        source: 'import',
        createdFrom: '2026-01-01',
        createdTo: '2026-03-31',
        position: ' Manager ',
        department: 'HR',
      })
    ).toEqual({
      q: 'acme',
      state: 'NSW',
      jobTypeId: 'job-1',
      status: 'lead',
      organisationId: 'org-1',
      serviceId: 'svc-1',
      source: 'import',
      createdFrom: '2026-01-01',
      createdTo: '2026-03-31',
      position: 'Manager',
      department: 'HR',
    })
  })

  it.each([
    ['status', { status: 'archived' }],
    ['status', { status: 'LEAD' }],
    ['source', { source: 'scraped' }],
    ['createdFrom', { createdFrom: '01/01/2026' }],
    ['createdTo', { createdTo: '2026-02-30' }],
    ['jobTypeId', { jobTypeId: 'x,status.eq.lead' }],
  ])('drops an invalid %s rather than trusting it', (key, definition) => {
    // Archived is never a segment status: archived contacts are out, full stop.
    expect(parseSegmentCriteria(definition)[key as keyof typeof EMPTY_CRITERIA]).toBeNull()
  })

  it('normalises a recognised state to its code', () => {
    expect(parseSegmentCriteria({ state: 'new south wales' }).state).toBe('NSW')
  })

  it('keeps a state it does not recognise, since dropping it would widen the segment', () => {
    expect(parseSegmentCriteria({ state: ' Ontario ' }).state).toBe('Ontario')
  })

  it('ignores keys it does not know, including consent and archive switches', () => {
    // The consent gate comes from the campaign's stream, never from the definition.
    const criteria = parseSegmentCriteria({
      subscribed: 'false',
      includeArchived: 'true',
      pageSize: '999999',
    })

    expect(criteria).toEqual(EMPTY_CRITERIA)
  })

  it('treats anything but an object as no criteria', () => {
    expect(parseSegmentCriteria(null)).toEqual(EMPTY_CRITERIA)
    expect(parseSegmentCriteria(['state'])).toEqual(EMPTY_CRITERIA)
    expect(parseSegmentCriteria('state=NSW')).toEqual(EMPTY_CRITERIA)
  })
})

describe('criteriaToDefinition', () => {
  it('stores only the criteria that are set', () => {
    expect(criteriaToDefinition({ ...EMPTY_CRITERIA, state: 'VIC', source: 'newsletter' })).toEqual({
      state: 'VIC',
      source: 'newsletter',
    })
  })

  it('round-trips', () => {
    const definition = { state: 'QLD', serviceId: 'svc-1', createdFrom: '2026-02-01' }

    expect(criteriaToDefinition(parseSegmentCriteria(definition))).toEqual(definition)
  })
})

describe('buildSegmentFilterExpression', () => {
  const build = (criteria: Partial<typeof EMPTY_CRITERIA>, orgIds: string[] = []) =>
    buildSegmentFilterExpression({ ...EMPTY_CRITERIA, ...criteria }, orgIds)

  it('is null when there are no criteria, meaning everyone with consent', () => {
    expect(build({})).toBeNull()
  })

  it('combines criteria with and()', () => {
    expect(build({ state: 'NSW', status: 'lead' })).toBe('and(state.eq."NSW",status.eq.lead)')
  })

  it('maps each id criterion to its column', () => {
    expect(build({ jobTypeId: 'job-1', organisationId: 'org-1' })).toBe(
      'and(job_type_id.eq.job-1,organisation_id.eq.org-1)'
    )
  })

  it('tests the service against the flattened service list', () => {
    expect(build({ serviceId: 'svc-1' })).toBe('and(service_ids.cs.{svc-1})')
  })

  it('reads dates as Sydney calendar days, end date inclusive', () => {
    expect(build({ createdFrom: '2026-07-01', createdTo: '2026-07-31' })).toBe(
      'and(created_at.gte."2026-06-30T14:00:00.000Z",created_at.lt."2026-07-31T14:00:00.000Z")'
    )
  })

  it('matches position and department as contained text', () => {
    expect(build({ position: '50%_off' })).toBe('and(position.ilike."%50\\\\%\\\\_off%")')
  })

  it('nests the free-text search as its own or()', () => {
    const expression = build({ q: 'acme', state: 'VIC' })!

    expect(expression.startsWith('and(state.eq."VIC",or(first_name.ilike.')).toBe(true)
    expect(expression.endsWith('))')).toBe(true)
  })

  it('keeps a hostile search term inside its quotes', () => {
    // Unquoted, this would add a clause that widens the audience.
    const expression = build({ q: 'x,status.eq.customer)' })!

    // With every quoted value removed, no clause of its own may be left behind.
    const unquoted = expression.replace(/"(?:[^"\\]|\\.)*"/g, '""')

    expect(unquoted).not.toContain('status.eq')
    expect(expression).toContain('"%x,status.eq.customer)%"')
  })

  it('includes matching organisations in the search', () => {
    expect(build({ q: 'acme' }, ['org-9'])).toContain('organisation_id.in.(org-9)')
  })
})

import {
  CONTACT_SORT_KEYS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildSearchOrExpression,
  contactFiltersToSearchParams,
  escapeLikePattern,
  parseContactFilters,
  SEARCH_ORGANISATION_CAP,
  parseContactIds,
  MAX_SELECTED_IDS,
  MAX_FILTER_TAG_IDS,
  industryKey,
  parseTagIds,
} from './query'

describe('parseContactFilters', () => {
  it('returns safe defaults for an empty query string', () => {
    expect(parseContactFilters({})).toEqual({
      q: null,
      ids: null,
      jobTypeId: null,
      tagIds: null,
      organisationId: null,
      industry: null,
      state: null,
      status: null,
      subscribed: null,
      subscribedToPrograms: null,
      includeArchived: false,
      sort: 'name',
      dir: 'asc',
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    })
  })

  it('reads the supported filters', () => {
    const filters = parseContactFilters({
      q: ' ada ',
      jobTypeId: 'job-1',
      state: 'nsw',
      status: 'customer',
      subscribed: 'true',
      sort: 'organisation',
      dir: 'desc',
      page: '3',
    })

    expect(filters).toMatchObject({
      q: 'ada',
      jobTypeId: 'job-1',
      state: 'NSW',
      status: 'customer',
      subscribed: true,
      sort: 'organisation',
      dir: 'desc',
      page: 3,
    })
  })

  describe('status', () => {
    it.each(['lead', 'prospect', 'customer', 'archived'])('accepts %s', (status) => {
      expect(parseContactFilters({ status }).status).toBe(status)
    })

    it('drops an unknown status rather than passing it to the database', () => {
      expect(parseContactFilters({ status: 'superuser' }).status).toBeNull()
      expect(parseContactFilters({ status: "customer'; drop table" }).status).toBeNull()
    })
  })

  describe('sort', () => {
    it.each(CONTACT_SORT_KEYS)('accepts the whitelisted key %s', (sort) => {
      expect(parseContactFilters({ sort }).sort).toBe(sort)
    })

    it('falls back to the default for an unknown sort key', () => {
      // Sort maps to a column name; an arbitrary value must never reach the query.
      expect(parseContactFilters({ sort: 'password' }).sort).toBe('name')
      expect(parseContactFilters({ sort: 'id; drop table contacts' }).sort).toBe('name')
    })

    it('falls back to ascending for an unknown direction', () => {
      expect(parseContactFilters({ dir: 'sideways' }).dir).toBe('asc')
    })
  })

  describe('pagination', () => {
    it('clamps page to at least 1', () => {
      expect(parseContactFilters({ page: '0' }).page).toBe(1)
      expect(parseContactFilters({ page: '-5' }).page).toBe(1)
      expect(parseContactFilters({ page: 'abc' }).page).toBe(1)
    })

    it('caps page size so a crafted URL cannot request the whole table', () => {
      expect(parseContactFilters({ pageSize: '100000' }).pageSize).toBe(MAX_PAGE_SIZE)
    })

    it('rejects a non-positive page size', () => {
      expect(parseContactFilters({ pageSize: '0' }).pageSize).toBe(DEFAULT_PAGE_SIZE)
    })
  })

  describe('booleans', () => {
    it.each([
      ['true', true],
      ['1', true],
      ['false', false],
      ['0', false],
    ])('reads %s as %p', (input, expected) => {
      expect(parseContactFilters({ subscribed: input }).subscribed).toBe(expected)
    })

    it('treats an unrecognised value as unset rather than false', () => {
      expect(parseContactFilters({ subscribed: 'maybe' }).subscribed).toBeNull()
    })
  })

  it('takes the first value when a param is repeated', () => {
    expect(parseContactFilters({ state: ['NSW', 'VIC'] }).state).toBe('NSW')
  })

  it('treats a blank search term as absent', () => {
    expect(parseContactFilters({ q: '   ' }).q).toBeNull()
  })

  it('accepts a URLSearchParams directly', () => {
    const params = new URLSearchParams('q=ada&status=customer&page=2')

    expect(parseContactFilters(params)).toMatchObject({
      q: 'ada',
      status: 'customer',
      page: 2,
    })
  })
})

describe('escapeLikePattern', () => {
  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern('ada')).toBe('ada')
  })

  it.each([
    ['percent', '100%', '100\\%'],
    ['underscore', 'a_b', 'a\\_b'],
    ['backslash', 'a\\b', 'a\\\\b'],
  ])('escapes a %s so it matches literally', (_label, input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected)
  })

  it('stops a lone wildcard from matching every row', () => {
    expect(escapeLikePattern('%')).toBe('\\%')
  })

  it('escapes the backslash before the wildcard, not after', () => {
    // Escaping in the wrong order turns '\%' into '\\%', which matches a literal
    // backslash followed by any string.
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%')
  })
})

describe('buildSearchOrExpression', () => {
  it('searches the expected columns', () => {
    const expression = buildSearchOrExpression('ada')

    expect(expression).toContain('first_name.ilike.')
    expect(expression).toContain('last_name.ilike.')
    expect(expression).toContain('email.ilike.')
  })

  it('wraps the term in wildcards for a contains match', () => {
    expect(buildSearchOrExpression('ada')).toContain('%ada%')
  })

  it('quotes each value so a comma cannot add a filter clause', () => {
    // PostgREST parses .or() as comma-separated conditions. An unquoted comma would
    // let a search term inject an extra condition.
    const expression = buildSearchOrExpression('a,b')

    expect(expression).not.toBeNull()
    expect(expression!).toContain('"')
    expect(expression!).not.toMatch(/ilike\.%a,b%/)
  })

  it('escapes a double quote so the value cannot break out of its quoting', () => {
    const expression = buildSearchOrExpression('a"b')

    expect(expression).toContain('\\"')
  })

  it.each([
    ['comma', 'a,b'],
    ['parenthesis', 'a)b'],
    ['dot', 'a.b'],
    ['quote', 'a"b'],
    ['backslash', 'a\\b'],
    ['injection attempt', 'x,status.eq.archived'],
  ])('neutralises a %s in the search term', (_label, term) => {
    const expression = buildSearchOrExpression(term)

    // Whatever the payload, each searchable contact field gets one ilike condition.
    expect(expression).not.toBeNull()
    expect(expression!.match(/ilike\./g)).toHaveLength(6)
  })

  it('returns null for an empty term', () => {
    expect(buildSearchOrExpression('')).toBeNull()
    expect(buildSearchOrExpression('   ')).toBeNull()
  })
})

describe('contactFiltersToSearchParams', () => {
  it('omits defaults so a clean view has a clean URL', () => {
    const params = contactFiltersToSearchParams(parseContactFilters({}))

    expect(params.toString()).toBe('')
  })

  it('round-trips a populated filter set', () => {
    const original = parseContactFilters({
      q: 'ada',
      state: 'NSW',
      status: 'customer',
      jobTypeId: 'job-1',
      subscribed: 'true',
      sort: 'organisation',
      dir: 'desc',
      page: '4',
      tagIds: `${TAG_A},${TAG_B}`,
      organisationId: ORG,
      industry: 'Health care',
    })

    const reparsed = parseContactFilters(contactFiltersToSearchParams(original))

    expect(reparsed).toEqual(original)
  })

  it('keeps a search term with spaces intact through the round trip', () => {
    const original = parseContactFilters({ q: 'ada lovelace' })
    const reparsed = parseContactFilters(contactFiltersToSearchParams(original))

    expect(reparsed.q).toBe('ada lovelace')
  })
})

describe('buildSearchOrExpression — organisation', () => {
  it('widens the search to contacts of a matching organisation', () => {
    const expression = buildSearchOrExpression('acme', ['org-1', 'org-2'])

    expect(expression).toContain('organisation_id.in.(org-1,org-2)')
  })

  it('omits the organisation clause when nothing matched', () => {
    const expression = buildSearchOrExpression('acme', [])

    expect(expression).not.toContain('organisation_id')
  })

  it('drops an id that is not a plain id shape', () => {
    // Ids come from our own database, but they are still interpolated into the
    // PostgREST grammar — a value carrying a comma or a paren would inject a clause.
    const expression = buildSearchOrExpression('acme', ['org-1', 'x),status.eq.archived,('])

    expect(expression).toContain('organisation_id.in.(org-1)')
    expect(expression).not.toContain('status.eq.archived')
  })

  it('caps how many organisations one term can expand to', () => {
    // PostgREST filters travel in the URL; an unbounded list fails on request length.
    const ids = Array.from({ length: SEARCH_ORGANISATION_CAP + 50 }, (_, i) => `org-${i}`)

    const expression = buildSearchOrExpression('a', ids)!
    const listed = expression.slice(expression.indexOf('organisation_id.in.(')).split(',')

    expect(listed).toHaveLength(SEARCH_ORGANISATION_CAP)
  })

  it('still returns null for an empty term even with organisations supplied', () => {
    expect(buildSearchOrExpression('   ', ['org-1'])).toBeNull()
  })
})

describe('parseContactIds', () => {
  it('reports no selection when the caller named none', () => {
    // Distinct from an empty selection: null means "use the filters".
    expect(parseContactIds(null)).toBeNull()
  })

  it('reads a comma-separated selection', () => {
    expect(parseContactIds('a1, b2 ,c3')).toEqual(['a1', 'b2', 'c3'])
  })

  it('collapses duplicates so a repeated id cannot inflate the request', () => {
    expect(parseContactIds('a1,a1,b2')).toEqual(['a1', 'b2'])
  })

  it('drops ids that are not a plain id shape', () => {
    // These would otherwise be interpolated into the PostgREST `in.(...)` grammar.
    expect(parseContactIds('a1,b2.eq.x,"c3",d4')).toEqual(['a1', 'd4'])
  })

  it('returns an empty selection rather than null when every id is malformed', () => {
    // Falling back to null here would export the whole filtered set instead of nothing.
    expect(parseContactIds('..,,%%')).toEqual([])
    expect(parseContactIds('')).toEqual([])
  })

  it('reads one id past the cap so an over-long selection is detectable', () => {
    const ids = Array.from({ length: MAX_SELECTED_IDS + 50 }, (_, i) => `id-${i}`)

    expect(parseContactIds(ids.join(','))).toHaveLength(MAX_SELECTED_IDS + 1)
  })
})

describe('parseContactFilters ids', () => {
  it('parses an explicit selection from the query string', () => {
    expect(parseContactFilters({ ids: 'a1,b2' }).ids).toEqual(['a1', 'b2'])
  })

  it('treats an empty ids param as an empty selection, not an absent one', () => {
    expect(parseContactFilters({ ids: '' }).ids).toEqual([])
  })

  it('leaves ids null when the param is absent', () => {
    expect(parseContactFilters({ q: 'ada' }).ids).toBeNull()
  })
})

const TAG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TAG_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const ORG = 'cccccccc-0000-4000-8000-000000000003'

describe('tag, organisation and industry filters', () => {
  it('reads tagIds as a de-duplicated list of UUIDs', () => {
    expect(parseContactFilters({ tagIds: ` ${TAG_A}, ${TAG_B},${TAG_A.toUpperCase()} ` }).tagIds).toEqual([TAG_A, TAG_B])
  })

  it('drops malformed tag ids, which could otherwise reach a PostgREST filter', () => {
    expect(parseTagIds(`${TAG_A},vip,1),tag_id.eq.x`)).toEqual([TAG_A])
  })

  it('turns the tag filter off when no usable id remains', () => {
    expect(parseContactFilters({ tagIds: 'vip' }).tagIds).toBeNull()
    expect(parseContactFilters({ tagIds: '' }).tagIds).toBeNull()
    expect(parseContactFilters({}).tagIds).toBeNull()
  })

  it('bounds the number of tag ids', () => {
    const many = Array.from({ length: 60 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(parseTagIds(many.join(','))).toHaveLength(MAX_FILTER_TAG_IDS)
  })

  it('accepts only a UUID organisation id', () => {
    expect(parseContactFilters({ organisationId: ORG }).organisationId).toBe(ORG)
    expect(parseContactFilters({ organisationId: 'acme' }).organisationId).toBeNull()
  })

  it('keeps the industry as typed and derives the comparison key', () => {
    expect(parseContactFilters({ industry: '  Health  ' }).industry).toBe('Health')
    expect(industryKey(' Health Care ')).toBe('health care')
  })

  it('ignores an industry longer than any stored one', () => {
    expect(parseContactFilters({ industry: 'x'.repeat(121) }).industry).toBeNull()
  })

  it('serialises the new filters with the documented param names', () => {
    const params = contactFiltersToSearchParams(
      parseContactFilters({ tagIds: `${TAG_A},${TAG_B}`, organisationId: ORG, industry: 'Health' })
    )

    expect(params.get('tagIds')).toBe(`${TAG_A},${TAG_B}`)
    expect(params.get('organisationId')).toBe(ORG)
    expect(params.get('industry')).toBe('Health')
  })
})

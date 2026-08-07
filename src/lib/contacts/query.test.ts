import {
  CONTACT_SORT_KEYS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildSearchOrExpression,
  contactFiltersToSearchParams,
  escapeLikePattern,
  parseContactFilters,
} from './query'

describe('parseContactFilters', () => {
  it('returns safe defaults for an empty query string', () => {
    expect(parseContactFilters({})).toEqual({
      q: null,
      jobTypeId: null,
      state: null,
      status: null,
      subscribed: null,
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

    // Whatever the payload, exactly three ilike conditions must be produced.
    expect(expression).not.toBeNull()
    expect(expression!.match(/ilike\./g)).toHaveLength(3)
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

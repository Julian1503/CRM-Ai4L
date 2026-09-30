import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { parseContactFilters } from './query'
import { applyContactFilters, archiveContact, contactSource, restoreContact,
  findOrganisationIdsMatching, fetchContactsForExport, fetchSelectedContactsForExport,
  sortSelectedRows, ContactExportLimitError, contactSelect, fetchContacts, toListRow,
} from './repository'

describe('contactSource', () => {
  it('reads through the active_contacts view by default', () => {
    // The view filters deleted_at, so forgetting the predicate in a query cannot
    // leak archived records.
    expect(contactSource(false)).toBe('active_contacts')
  })

  it('reads the base table when archived rows are wanted', () => {
    expect(contactSource(true)).toBe('contacts')
  })
})

describe('applyContactFilters', () => {
  function apply(params: Record<string, string>) {
    const builder = createQueryBuilderMock()
    applyContactFilters(builder, parseContactFilters(params))
    return builder
  }

  it('applies no equality filters when nothing is selected', () => {
    const builder = apply({})

    expect(builder.allFor('eq')).toHaveLength(0)
    expect(builder.allFor('or')).toHaveLength(0)
  })

  it('narrows to an explicit selection of ids', () => {
    expect(apply({ ids: 'c1,c2' }).allFor('in')).toContainEqual({
      method: 'in',
      args: ['id', ['c1', 'c2']],
    })
  })

  it('applies no id filter when the caller named no selection', () => {
    expect(apply({}).allFor('in')).toHaveLength(0)
  })

  it('matches nothing when a selection resolved to no valid id', () => {
    // The dangerous alternative is falling back to the filters and exporting everything.
    expect(apply({ ids: '' }).allFor('in')).toContainEqual({ method: 'in', args: ['id', []] })
  })

  it('keeps the other filters alongside a selection', () => {
    // A selected row that no longer matches the view must not be exported.
    const builder = apply({ ids: 'c1', status: 'customer' })

    expect(builder.allFor('in')).toHaveLength(1)
    expect(builder.allFor('eq')).toContainEqual({ method: 'eq', args: ['status', 'customer'] })
  })

  it('filters by job type', () => {
    expect(apply({ jobTypeId: 'job-1' }).allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['job_type_id', 'job-1'],
    })
  })

  it('filters by state', () => {
    expect(apply({ state: 'nsw' }).allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['state', 'NSW'],
    })
  })

  it('filters by status', () => {
    expect(apply({ status: 'customer' }).allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['status', 'customer'],
    })
  })

  it('filters by newsletter subscription', () => {
    expect(apply({ subscribed: 'true' }).allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['subscribed_to_newsletter', true],
    })
  })

  it('combines multiple filters', () => {
    const builder = apply({ state: 'VIC', status: 'lead', jobTypeId: 'job-2' })

    expect(builder.allFor('eq')).toHaveLength(3)
  })

  it('applies the search as a single or() expression', () => {
    const builder = apply({ q: 'ada' })
    const orCalls = builder.allFor('or')

    expect(orCalls).toHaveLength(1)
    expect(String(orCalls[0].args[0])).toContain('first_name.ilike.')
  })

  it('orders by the mapped column, never the raw sort key', () => {
    const builder = apply({ sort: 'organisation', dir: 'desc' })

    expect(builder.argsFor('order')).toEqual(['organisation_id', { ascending: false }])
  })

  it('falls back to a safe column for an unknown sort key', () => {
    const builder = apply({ sort: 'password' })

    expect(builder.argsFor('order')).toEqual(['last_name', { ascending: true }])
  })

  it('always applies a bounded range, so no query is unbounded', () => {
    const builder = apply({})

    expect(builder.argsFor('range')).toEqual([0, 49])
  })

  it('offsets the range by page', () => {
    expect(apply({ page: '3' }).argsFor('range')).toEqual([100, 149])
  })

  it('caps the range at the maximum page size', () => {
    expect(apply({ pageSize: '99999' }).argsFor('range')).toEqual([0, 199])
  })

  it('restricts the archive view to archived rows only', () => {
    const builder = apply({ includeArchived: 'true' })

    expect(builder.allFor('not')).toContainEqual({
      method: 'not',
      args: ['deleted_at', 'is', null],
    })
  })
})

describe('archiveContact', () => {
  it('sets deleted_at instead of deleting the row', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(builder)

    await archiveContact(db as never, 'contact-1')

    expect(db.from).toHaveBeenCalledWith('contacts')
    expect(builder.allFor('delete')).toHaveLength(0)

    const update = builder.argsFor('update') as [Record<string, unknown>]
    expect(update[0]).toMatchObject({ deleted_at: expect.any(String) })
    expect(update[0].status).toBe('archived')
  })

  it('targets exactly one contact and skips already-archived rows', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(builder)

    await archiveContact(db as never, 'contact-1')

    expect(builder.allFor('eq')).toContainEqual({ method: 'eq', args: ['id', 'contact-1'] })
    expect(builder.allFor('is')).toContainEqual({ method: 'is', args: ['deleted_at', null] })
  })

  it('surfaces a database error', async () => {
    const builder = createQueryBuilderMock({ data: null, error: { message: 'permission denied' } })
    const db = createDbMock(builder)

    await expect(archiveContact(db as never, 'contact-1')).rejects.toThrow(/permission denied/)
  })
})

describe('restoreContact', () => {
  it('clears deleted_at and returns the contact to prospect', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(builder)

    await restoreContact(db as never, 'contact-1')

    const update = builder.argsFor('update') as [Record<string, unknown>]
    expect(update[0]).toMatchObject({ deleted_at: null, status: 'prospect' })
  })

  it('explains the conflict when the email is already live again', async () => {
    // contacts_email_active_idx is a partial unique index; restoring a contact whose
    // address was since reused must not surface as a raw 23505.
    const builder = createQueryBuilderMock({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })
    const db = createDbMock(builder)

    await expect(restoreContact(db as never, 'contact-1')).rejects.toThrow(
      /already an active contact with that email/i
    )
  })
})

describe('fetchContactsForExport', () => {
  const filters = parseContactFilters({})

  it('loads every page rather than trusting one oversized response', async () => {
    const pages = [
      createQueryBuilderMock({ data: [{ id: 'c1' }, { id: 'c2' }], error: null, count: 3 }),
      createQueryBuilderMock({ data: [{ id: 'c3' }], error: null, count: 3 }),
    ]
    let index = 0
    const db = createDbMock(() => pages[Math.min(index++, pages.length - 1)])

    const result = await fetchContactsForExport(db as never, filters, 10, 2)

    expect(result.rows.map((row) => row.id)).toEqual(['c1', 'c2', 'c3'])
    expect(pages[0].argsFor('range')).toEqual([0, 1])
    expect(pages[1].argsFor('range')).toEqual([2, 3])
  })

  it('throws before presenting a partial export above the configured limit', async () => {
    const builder = createQueryBuilderMock({ data: [{ id: 'c1' }], error: null, count: 11 })

    await expect(
      fetchContactsForExport(createDbMock(builder) as never, filters, 10, 2)
    ).rejects.toBeInstanceOf(ContactExportLimitError)
  })

  it('fails if the provider stops returning rows before the reported total', async () => {
    const pages = [
      createQueryBuilderMock({ data: [{ id: 'c1' }, { id: 'c2' }], error: null, count: 3 }),
      createQueryBuilderMock({ data: [], error: null, count: 3 }),
    ]
    let index = 0

    await expect(
      fetchContactsForExport(
        createDbMock(() => pages[Math.min(index++, pages.length - 1)]) as never,
        filters,
        10,
        2
      )
    ).rejects.toThrow(/stopped after 2 of 3/i)
  })
})

describe('sortSelectedRows', () => {
  const rows = [
    { id: 'c2', last_name: 'Byron', first_name: 'Ada', organisation: { name: 'Zeta' } },
    { id: 'c1', last_name: 'Adams', first_name: 'Zoe', organisation: { name: 'Alpha' } },
  ]

  it('orders by name ascending', () => {
    expect(sortSelectedRows(rows as never, 'name', 'asc').map((row) => row.id)).toEqual([
      'c1',
      'c2',
    ])
  })

  it('reverses for a descending sort', () => {
    expect(sortSelectedRows(rows as never, 'name', 'desc').map((row) => row.id)).toEqual([
      'c2',
      'c1',
    ])
  })

  it('orders by organisation name rather than the id the database sorts on', () => {
    expect(
      sortSelectedRows(rows as never, 'organisation', 'asc').map((row) => row.id)
    ).toEqual(['c1', 'c2'])
  })

  it('leaves the caller array untouched', () => {
    const original = [...rows]
    sortSelectedRows(rows as never, 'name', 'desc')

    expect(rows).toEqual(original)
  })
})

describe('fetchSelectedContactsForExport', () => {
  const filters = parseContactFilters({})

  it('requests the ids in bounded chunks', async () => {
    const pages = [
      createQueryBuilderMock({ data: [{ id: 'c1' }, { id: 'c2' }], error: null, count: 2 }),
      createQueryBuilderMock({ data: [{ id: 'c3' }], error: null, count: 1 }),
    ]
    let index = 0
    const db = createDbMock(() => pages[Math.min(index++, pages.length - 1)])

    const result = await fetchSelectedContactsForExport(
      db as never,
      filters,
      ['c1', 'c2', 'c3'],
      10,
      2
    )

    expect(result.rows.map((row) => row.id)).toEqual(['c1', 'c2', 'c3'])
    expect(result.total).toBe(3)
    expect(pages[0].argsFor('in')).toEqual(['id', ['c1', 'c2']])
    expect(pages[1].argsFor('in')).toEqual(['id', ['c3']])
  })

  it('accepts fewer rows than ids, because a selected row may have been filtered out', async () => {
    const builder = createQueryBuilderMock({ data: [{ id: 'c1' }], error: null, count: 1 })

    const result = await fetchSelectedContactsForExport(
      createDbMock(builder) as never,
      filters,
      ['c1', 'c2'],
      10
    )

    expect(result.rows.map((row) => row.id)).toEqual(['c1'])
  })

  it('queries nothing for an empty selection', async () => {
    const db = createDbMock(createQueryBuilderMock())

    const result = await fetchSelectedContactsForExport(db as never, filters, [], 10)

    expect(result).toEqual({ rows: [], total: 0 })
    expect(db.from).not.toHaveBeenCalled()
  })

  it('refuses a selection above the safe limit', async () => {
    await expect(
      fetchSelectedContactsForExport(
        createDbMock(createQueryBuilderMock()) as never,
        filters,
        ['c1', 'c2', 'c3'],
        2
      )
    ).rejects.toBeInstanceOf(ContactExportLimitError)
  })

  it('is the path fetchContactsForExport takes when a selection is present', async () => {
    const builder = createQueryBuilderMock({ data: [{ id: 'c1' }], error: null, count: 1 })

    const result = await fetchContactsForExport(
      createDbMock(builder) as never,
      parseContactFilters({ ids: 'c1' }),
      10
    )

    expect(result.rows.map((row) => row.id)).toEqual(['c1'])
    expect(builder.argsFor('in')).toEqual(['id', ['c1']])
  })
})

describe('findOrganisationIdsMatching', () => {
  it('returns the ids of organisations whose name matches', async () => {
    const builder = createQueryBuilderMock({ data: [{ id: 'o1' }, { id: 'o2' }], error: null })

    const ids = await findOrganisationIdsMatching(createDbMock(builder) as never, 'acme')

    expect(ids).toEqual(['o1', 'o2'])
    expect(builder.argsFor('ilike')).toEqual(['name', '%acme%'])
  })

  it('escapes LIKE metacharacters so a term matches literally', () => {
    const builder = createQueryBuilderMock({ data: [], error: null })

    return findOrganisationIdsMatching(createDbMock(builder) as never, '100%_test').then(() => {
      // Unescaped, `%` matches everything and `_` matches any character.
      expect(builder.argsFor('ilike')).toEqual(['name', String.raw`%100\%\_test%`])
    })
  })

  it('bounds the lookup, because the ids end up in a URL', async () => {
    const builder = createQueryBuilderMock({ data: [], error: null })

    await findOrganisationIdsMatching(createDbMock(builder) as never, 'a')

    expect(builder.argsFor('limit')).toEqual([100])
  })

  it('does not query at all for an empty term', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: [], error: null }))

    expect(await findOrganisationIdsMatching(db as never, '  ')).toEqual([])
    expect(db.from).not.toHaveBeenCalled()
  })

  it('degrades to no organisation matches rather than failing the whole search', async () => {
    // Organisation is one of several fields the search covers. Losing it should narrow
    // the results, not turn a search into an error page.
    const builder = createQueryBuilderMock({ data: null, error: { message: 'denied' } })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      findOrganisationIdsMatching(createDbMock(builder) as never, 'acme')
    ).resolves.toEqual([])

    warn.mockRestore()
  })
})

const TAG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TAG_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const ORG = 'cccccccc-0000-4000-8000-000000000003'

describe('tag, organisation and industry filters', () => {
  function apply(params: Record<string, string>) {
    const builder = createQueryBuilderMock()
    applyContactFilters(builder, parseContactFilters(params))
    return builder
  }

  it('matches any of the tags through the filter-only embed', () => {
    expect(apply({ tagIds: `${TAG_A},${TAG_B}` }).allFor('in')).toContainEqual({
      method: 'in',
      args: ['tag_match.tag_id', [TAG_A, TAG_B]],
    })
  })

  it('never filters the display embed, which would hide the other tags', () => {
    const inCalls = apply({ tagIds: TAG_A }).allFor('in')
    expect(inCalls.some((call) => String(call.args[0]).startsWith('tag_links'))).toBe(false)
  })

  it('filters by organisation id', () => {
    expect(apply({ organisationId: ORG }).allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['organisation_id', ORG],
    })
  })

  it('filters by the normalised industry key', () => {
    expect(apply({ industry: ' Health Care ' }).allFor('eq')).toContainEqual({
      method: 'eq',
      args: ['industry_match.industry_key', 'health care'],
    })
  })

  it('combines every family with AND alongside the existing filters', () => {
    const builder = apply({ tagIds: TAG_A, organisationId: ORG, industry: 'Health', status: 'lead' })

    expect(builder.allFor('in')).toHaveLength(1)
    expect(builder.allFor('eq')).toHaveLength(3)
  })

  it('adds no tag or industry filter when none is set', () => {
    const builder = apply({})
    expect(builder.allFor('in')).toHaveLength(0)
    expect(builder.allFor('eq')).toHaveLength(0)
  })
})

describe('contactSelect', () => {
  it('always embeds the tags for display', () => {
    expect(contactSelect({ tagIds: null, industry: null })).toBe(
      '*, organisation:organisations(name), job_type:job_types(name), tag_links:contact_tags(tag:tags(id,name))'
    )
  })

  it('adds an inner embed only for the filters in use', () => {
    const select = contactSelect({ tagIds: [TAG_A], industry: 'Health' })

    expect(select).toContain('tag_match:contact_tags!inner(tag_id)')
    expect(select).toContain('industry_match:organisations!inner(industry_key)')
  })
})

describe('toListRow', () => {
  it('flattens tags sorted by name and drops filter-only embeds', () => {
    const row = toListRow({
      id: 'c1',
      tag_links: [{ tag: { id: 't2', name: 'workshop' } }, { tag: { id: 't1', name: 'VIP' } }, { tag: null }],
      tag_match: [{ tag_id: 't1' }],
      industry_match: { industry_key: 'health' },
    } as never)

    expect(row.tags).toEqual([
      { id: 't1', name: 'VIP' },
      { id: 't2', name: 'workshop' },
    ])
    expect(row).not.toHaveProperty('tag_links')
    expect(row).not.toHaveProperty('tag_match')
    expect(row).not.toHaveProperty('industry_match')
  })

  it('gives a contact without tags an empty list', () => {
    expect(toListRow({ id: 'c1' } as never).tags).toEqual([])
  })
})

describe('fetchContacts', () => {
  it('returns each contact once with its tags and an exact total', async () => {
    const builder = createQueryBuilderMock({
      data: [{ id: 'c1', tag_links: [{ tag: { id: TAG_A, name: 'VIP' } }], tag_match: [{ tag_id: TAG_A }] }],
      error: null,
      count: 1,
    })
    const db = createDbMock(builder)

    const page = await fetchContacts(db as never, parseContactFilters({ tagIds: `${TAG_A},${TAG_B}` }))

    expect(builder.argsFor('select')).toEqual([
      expect.stringContaining('tag_match:contact_tags!inner(tag_id)'),
      { count: 'exact' },
    ])
    expect(page).toEqual({ rows: [{ id: 'c1', tags: [{ id: TAG_A, name: 'VIP' }] }], total: 1 })
  })
})

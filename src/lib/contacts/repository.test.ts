import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { parseContactFilters } from './query'
import { applyContactFilters, archiveContact, contactSource, restoreContact,
  findOrganisationIdsMatching,
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

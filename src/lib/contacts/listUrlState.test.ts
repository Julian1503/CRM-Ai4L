/** @jest-environment node */
import {
  contactApiQuery,
  DEFAULT_CONTACT_LIST_STATE,
  readContactListState,
  sameContactSelection,
  updateContactListState,
  writeContactListState,
} from './listUrlState'

const TAG_A = '11111111-1111-4111-8111-111111111111'
const TAG_B = '22222222-2222-4222-8222-222222222222'
const ORG = '33333333-3333-4333-8333-333333333333'

const read = (query: string) => readContactListState(new URLSearchParams(query))

describe('readContactListState', () => {
  it('reads a full, valid view', () => {
    expect(
      read(
        `q=ada&status=customer&jobTypeId=${ORG}&state=nsw&tagIds=${TAG_A},${TAG_B}&organisationId=${ORG}&industry=Health&sort=organisation&dir=desc&page=3&pageSize=100`
      )
    ).toEqual({
      q: 'ada',
      status: 'customer',
      jobTypeId: ORG,
      state: 'NSW',
      tagIds: [TAG_A, TAG_B],
      organisationId: ORG,
      industry: 'Health',
      sort: 'organisation',
      dir: 'desc',
      page: 3,
      pageSize: 100,
    })
  })

  it('is the default view for an empty URL', () => {
    expect(read('')).toEqual(DEFAULT_CONTACT_LIST_STATE)
  })

  it('falls back field by field for anything malformed', () => {
    expect(
      read(
        `status=vip&jobTypeId=1&state=XX&tagIds=nope,${TAG_A},${TAG_A}&organisationId=x&industry=${'i'.repeat(121)}&sort=password&dir=up&page=abc&pageSize=7&q=${'q'.repeat(300)}`
      )
    ).toEqual({ ...DEFAULT_CONTACT_LIST_STATE, tagIds: [TAG_A], q: 'q'.repeat(200) })
    expect(read('page=0').page).toBe(1)
    expect(read('page=-2').page).toBe(1)
  })
})

describe('writeContactListState', () => {
  it('omits defaults, so the plain list is a bare path', () => {
    expect(writeContactListState(DEFAULT_CONTACT_LIST_STATE).toString()).toBe('')
  })

  it('round-trips every field', () => {
    const state = read(`q=ada&status=newsletter&state=VIC&tagIds=${TAG_A}&organisationId=${ORG}&industry=Health&sort=created&dir=desc&page=2&pageSize=25&jobTypeId=${ORG}`)
    expect(read(writeContactListState(state).toString())).toEqual(state)
  })
})

describe('updateContactListState', () => {
  const onPage3 = { ...DEFAULT_CONTACT_LIST_STATE, page: 3 }

  it('returns to page 1 when the selection changes', () => {
    expect(updateContactListState(onPage3, { q: 'ada' }).page).toBe(1)
    expect(updateContactListState(onPage3, { tagIds: [TAG_A] }).page).toBe(1)
  })

  it('keeps the page for sorting, paging or an unchanged filter', () => {
    expect(updateContactListState(onPage3, { sort: 'created' }).page).toBe(3)
    expect(updateContactListState(onPage3, { q: '' }).page).toBe(3)
    expect(updateContactListState(onPage3, { q: 'x', page: 2 }).page).toBe(2)
  })

  it('sameContactSelection ignores page, size and sort', () => {
    expect(sameContactSelection(onPage3, { ...DEFAULT_CONTACT_LIST_STATE, sort: 'created', pageSize: 25 })).toBe(true)
    expect(sameContactSelection(onPage3, { ...DEFAULT_CONTACT_LIST_STATE, state: 'NSW' })).toBe(false)
  })
})

describe('contactApiQuery', () => {
  it.each([
    ['lead', 'status=lead'],
    ['prospect', 'status=prospect'],
    ['customer', 'status=customer'],
    ['newsletter', 'subscribed=true'],
    ['programs', 'programs=true'],
  ] as const)('maps the %s tab', (status, expected) => {
    expect(contactApiQuery({ ...DEFAULT_CONTACT_LIST_STATE, status })).toContain(expected)
  })

  it('carries filters and always the sort, never the page', () => {
    const query = new URLSearchParams(
      contactApiQuery({ ...DEFAULT_CONTACT_LIST_STATE, q: ' ada ', jobTypeId: ORG, state: 'NSW', tagIds: [TAG_A, TAG_B], organisationId: ORG, industry: 'Health', page: 4 })
    )
    expect(Object.fromEntries(query)).toEqual({
      q: 'ada',
      jobTypeId: ORG,
      state: 'NSW',
      tagIds: `${TAG_A},${TAG_B}`,
      organisationId: ORG,
      industry: 'Health',
      sort: 'name',
      dir: 'asc',
    })
    expect(contactApiQuery(DEFAULT_CONTACT_LIST_STATE)).toBe('sort=name&dir=asc')
  })
})

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildPageMeta,
  getPageRange,
  readPageParams,
} from './pagination'

describe('readPageParams', () => {
  it('defaults to the first page at the default size', () => {
    expect(readPageParams(new URLSearchParams())).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE })
  })

  it('reads an explicit page and size', () => {
    expect(readPageParams(new URLSearchParams('page=4&pageSize=25'))).toEqual({
      page: 4,
      pageSize: 25,
    })
  })

  it('falls back rather than erroring on an unparseable page', () => {
    // A stale bookmark should show the first page, not a 400.
    expect(readPageParams({ page: 'abc' }).page).toBe(1)
    expect(readPageParams({ page: '0' }).page).toBe(1)
    expect(readPageParams({ page: '-5' }).page).toBe(1)
  })

  it('caps page size so a crafted URL cannot request the whole table', () => {
    expect(readPageParams({ pageSize: '100000' }).pageSize).toBe(MAX_PAGE_SIZE)
  })

  it('rejects a non-positive page size', () => {
    expect(readPageParams({ pageSize: '0' }).pageSize).toBe(DEFAULT_PAGE_SIZE)
  })

  it('takes the first value of a repeated param', () => {
    expect(readPageParams({ page: ['3', '9'] }).page).toBe(3)
  })

  it('honours a caller-supplied default size', () => {
    expect(readPageParams(new URLSearchParams(), 10).pageSize).toBe(10)
  })
})

describe('getPageRange', () => {
  it('starts at zero on the first page', () => {
    expect(getPageRange({ page: 1, pageSize: 50 })).toEqual({ from: 0, to: 49 })
  })

  it('offsets by whole pages', () => {
    expect(getPageRange({ page: 3, pageSize: 20 })).toEqual({ from: 40, to: 59 })
  })
})

describe('buildPageMeta', () => {
  it('reports more pages ahead when the total exceeds the page', () => {
    expect(buildPageMeta({ page: 1, pageSize: 50 }, 120)).toEqual({
      page: 1,
      pageSize: 50,
      total: 120,
      pageCount: 3,
      hasMore: true,
    })
  })

  it('reports no more pages on the last one', () => {
    expect(buildPageMeta({ page: 3, pageSize: 50 }, 120).hasMore).toBe(false)
  })

  it('reports no more pages when the total lands exactly on a boundary', () => {
    expect(buildPageMeta({ page: 2, pageSize: 50 }, 100).hasMore).toBe(false)
  })

  it('reads an empty list as page 1 of 1', () => {
    expect(buildPageMeta({ page: 1, pageSize: 50 }, 0)).toMatchObject({ pageCount: 1, hasMore: false })
  })

  it('treats a missing count as empty rather than propagating NaN', () => {
    // Supabase returns a null count when it cannot compute one; NaN would reach the UI
    // as "Page 1 of NaN".
    expect(buildPageMeta({ page: 1, pageSize: 50 }, Number.NaN)).toMatchObject({
      total: 0,
      pageCount: 1,
    })
  })
})

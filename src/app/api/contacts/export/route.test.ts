/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { MAX_SELECTED_IDS } from '@/lib/contacts/query'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({
  getSession: () => mockGetSession(),
}))

jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { GET, POST } from './route'

const ORIGIN = 'https://crm.example.com'

const contactRow = {
  id: 'c1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  state: 'NSW',
  status: 'customer',
  subscribed_to_newsletter: true,
  created_at: '2026-01-01T00:00:00.000Z',
  organisation: { name: 'Analytical Engines' },
  job_type: { name: 'Electrician' },
}

function setRows(rows: unknown[]) {
  const builder = createQueryBuilderMock({ data: rows, error: null, count: rows.length })
  mockCreateServerClient.mockResolvedValue(createDbMock(builder))
  return builder
}

function get(query = '') {
  return GET(new NextRequest(`${ORIGIN}/api/contacts/export${query}`))
}

describe('GET /api/contacts/export', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setRows([contactRow])
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await get()

    expect(response.status).toBe(401)
    // The route must verify independently; proxy.ts is an optimistic check only.
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('returns a CSV attachment', async () => {
    const response = await get()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    expect(response.headers.get('content-disposition')).toMatch(/attachment; filename="contacts-/)
  })

  it('prepends a UTF-8 BOM so Excel reads accents correctly', async () => {
    // Must inspect the raw bytes: Response.text() performs a UTF-8 decode, which
    // strips a leading BOM per spec, so a text assertion would always fail even
    // when the BOM is correctly present on the wire.
    const bytes = new Uint8Array(await (await get()).arrayBuffer())

    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
  })

  it('defaults to the full format', async () => {
    const body = await (await get()).text()

    expect(body).toContain('Job Type')
  })

  it('honours the emailoctopus format', async () => {
    const body = await (await get('?format=emailoctopus')).text()

    expect(body).toContain('EmailAddress,FirstName,LastName')
    expect(body).not.toContain('Job Type')
  })

  it('rejects an unknown format instead of silently defaulting', async () => {
    const response = await get('?format=pdf')

    expect(response.status).toBe(400)
  })

  it('applies the active filters to the export', async () => {
    const builder = setRows([contactRow])

    await get('?state=VIC&status=lead')

    expect(builder.allFor('eq')).toContainEqual({ method: 'eq', args: ['state', 'VIC'] })
    expect(builder.allFor('eq')).toContainEqual({ method: 'eq', args: ['status', 'lead'] })
  })

  it('applies the tag, organisation and industry filters to the export', async () => {
    const builder = setRows([contactRow])
    const tag = 'aaaaaaaa-0000-4000-8000-000000000001'
    const org = 'cccccccc-0000-4000-8000-000000000003'

    await get(`?tagIds=${tag}&organisationId=${org}&industry=Health`)

    expect(builder.argsFor('select')?.[0]).toContain('tag_match:contact_tags!inner(tag_id)')
    expect(builder.allFor('in')).toContainEqual({ method: 'in', args: ['tag_match.tag_id', [tag]] })
    expect(builder.allFor('eq')).toContainEqual({ method: 'eq', args: ['organisation_id', org] })
    expect(builder.allFor('eq')).toContainEqual({ method: 'eq', args: ['industry_match.industry_key', 'health'] })
  })

  it('includes a Tags column in the full export', async () => {
    setRows([{ ...contactRow, tag_links: [{ tag: { id: 't1', name: 'VIP' } }] }])

    const body = await (await get()).text()

    expect(body).toContain('Tags')
    expect(body).toContain('VIP')
  })

  it('exports beyond one screen of results but stays bounded', async () => {
    const builder = setRows([contactRow])

    await get()

    const range = builder.argsFor('range') as [number, number]
    expect(range[0]).toBe(0)
    // Larger than a UI page, but capped rather than unbounded.
    expect(range[1]).toBeGreaterThan(200)
    expect(range[1]).toBeLessThan(100_000)
  })

  it('refuses an export above the safe limit instead of truncating it', async () => {
    const builder = createQueryBuilderMock({
      data: [contactRow],
      error: null,
      count: 10_001,
    })
    mockCreateServerClient.mockResolvedValue(createDbMock(builder))

    const response = await get()

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ total: 10_001, maxRows: 10_000 })
  })

  it('excludes archived contacts by default', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: [], error: null, count: 0 }))
    mockCreateServerClient.mockResolvedValue(db)

    await get()

    expect(db.from).toHaveBeenCalledWith('active_contacts')
  })

  it('escapes a formula payload in the exported body', async () => {
    setRows([{ ...contactRow, first_name: '=cmd|calc' }])

    const body = await (await get()).text()

    expect(body).toContain(`'=cmd|calc`)
  })

  it('returns 500 with a message when the query fails', async () => {
    const builder = createQueryBuilderMock({ data: null, error: { message: 'boom' }, count: null })
    mockCreateServerClient.mockResolvedValue(createDbMock(builder))

    const response = await get()

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
  })

  it('marks the response private so a shared cache cannot retain contact data', async () => {
    const response = await get()

    expect(response.headers.get('cache-control')).toContain('no-store')
  })
})

describe('POST /api/contacts/export', () => {
  function post(body: Record<string, string>, query = '') {
    const form = new URLSearchParams(body)

    return POST(
      new NextRequest(`${ORIGIN}/api/contacts/export${query}`, {
        method: 'POST',
        body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    )
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setRows([contactRow])
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await post({ ids: 'c1', format: 'full' })

    expect(response.status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('exports only the selected contacts', async () => {
    const builder = setRows([contactRow])

    const response = await post({ ids: 'c1,c2', format: 'full' })

    expect(response.status).toBe(200)
    expect(builder.argsFor('in')).toEqual(['id', ['c1', 'c2']])
    expect(response.headers.get('Content-Disposition')).toContain('attachment')
  })

  it('keeps the active filters alongside the selection', async () => {
    // A row ticked before the filter changed must not slip into the export.
    const builder = setRows([contactRow])

    await post({ ids: 'c1', format: 'full' }, '?status=customer')

    expect(builder.allFor('eq')).toContainEqual({ method: 'eq', args: ['status', 'customer'] })
  })

  it('refuses a request that names no selection at all', async () => {
    const response = await post({ format: 'full' })

    expect(response.status).toBe(400)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('refuses a selection where no id survived validation', async () => {
    // The dangerous alternative is falling back to exporting every matching contact.
    const response = await post({ ids: 'a.b,"c"', format: 'full' })

    expect(response.status).toBe(400)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('refuses a selection above the cap rather than truncating it', async () => {
    const ids = Array.from({ length: MAX_SELECTED_IDS + 5 }, (_, i) => `id-${i}`).join(',')

    const response = await post({ ids, format: 'full' })

    expect(response.status).toBe(422)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('rejects an unknown format instead of silently defaulting', async () => {
    const response = await post({ ids: 'c1', format: 'sqlite' })

    expect(response.status).toBe(400)
  })

  it('honours the emailoctopus format', async () => {
    const response = await post({ ids: 'c1', format: 'emailoctopus' })

    expect(await response.text()).toContain('EmailAddress')
  })

  it('marks the response private so a shared cache cannot retain contact data', async () => {
    const response = await post({ ids: 'c1', format: 'full' })

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

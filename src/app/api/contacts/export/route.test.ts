/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({
  getSession: () => mockGetSession(),
}))

jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { GET } from './route'

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

  it('exports beyond one screen of results but stays bounded', async () => {
    const builder = setRows([contactRow])

    await get()

    const range = builder.argsFor('range') as [number, number]
    expect(range[0]).toBe(0)
    // Larger than a UI page, but capped rather than unbounded.
    expect(range[1]).toBeGreaterThan(200)
    expect(range[1]).toBeLessThan(100_000)
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

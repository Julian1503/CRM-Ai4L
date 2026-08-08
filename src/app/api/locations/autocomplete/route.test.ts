/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockGetSession = jest.fn()
const mockFetch = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))

global.fetch = mockFetch as unknown as typeof fetch

import { GET } from './route'

const ORIGINAL_ENV = process.env

function request(query = '?q=sydney') {
  return new NextRequest(`https://crm.example.com/api/locations/autocomplete${query}`)
}

function geoapifyResponse(results: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ results }) }
}

describe('GET /api/locations/autocomplete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...ORIGINAL_ENV, GEOAPIFY_API_KEY: 'geo-key' }
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    mockFetch.mockResolvedValue(geoapifyResponse([]))
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('refuses an unauthenticated caller', async () => {
    // This route spends the client's Geoapify quota on every call, so an open
    // endpoint is a billing vector as well as an information one.
    mockGetSession.mockResolvedValue(null)

    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('never leaks the API key to the caller', async () => {
    mockFetch.mockResolvedValue(
      geoapifyResponse([{ formatted: 'Sydney NSW', state: 'New South Wales' }])
    )

    const body = await (await GET(request())).text()

    expect(body).not.toContain('geo-key')
  })

  it('returns suggestions', async () => {
    mockFetch.mockResolvedValue(
      geoapifyResponse([{ formatted: 'Sydney NSW 2000', state: 'New South Wales' }])
    )

    const response = await GET(request())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.suggestions.length).toBeGreaterThan(0)
  })

  it('does not call the provider for a short query', async () => {
    const response = await GET(request('?q=sy'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ suggestions: [] })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('reports unconfigured rather than failing obscurely', async () => {
    delete process.env.GEOAPIFY_API_KEY

    expect((await GET(request())).status).toBe(503)
  })

  it('surfaces a provider failure as a gateway error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })

    expect((await GET(request())).status).toBe(502)
  })

  it('survives a network failure', async () => {
    mockFetch.mockRejectedValue(new Error('offline'))

    expect((await GET(request())).status).toBe(502)
  })

  it('marks every response uncacheable', async () => {
    const response = await GET(request())

    expect(response.headers.get('cache-control')).toContain('no-store')
  })
})

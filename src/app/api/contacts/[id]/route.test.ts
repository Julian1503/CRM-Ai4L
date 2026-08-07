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

import { DELETE, POST } from './route'

const ORIGIN = 'https://crm.example.com'

function context(id: string) {
  // Next.js 16: route params arrive as a Promise.
  return { params: Promise.resolve({ id }) }
}

function setResult(result: unknown) {
  const builder = createQueryBuilderMock(result)
  mockCreateServerClient.mockResolvedValue(createDbMock(builder))
  return builder
}

describe('DELETE /api/contacts/[id] — archive', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setResult({ data: null, error: null })
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await DELETE(
      new NextRequest(`${ORIGIN}/api/contacts/c1`, { method: 'DELETE' }),
      context('c1')
    )

    expect(response.status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('archives rather than deleting the row', async () => {
    const builder = setResult({ data: null, error: null })

    const response = await DELETE(
      new NextRequest(`${ORIGIN}/api/contacts/c1`, { method: 'DELETE' }),
      context('c1')
    )

    expect(response.status).toBe(200)
    // The client's requirement is that records are archived, never removed.
    expect(builder.allFor('delete')).toHaveLength(0)
    expect(builder.argsFor('update')).toBeDefined()
  })

  it('rejects a missing id', async () => {
    const response = await DELETE(
      new NextRequest(`${ORIGIN}/api/contacts/`, { method: 'DELETE' }),
      context('')
    )

    expect(response.status).toBe(400)
  })

  it('reports a failure rather than claiming success', async () => {
    setResult({ data: null, error: { message: 'permission denied' } })

    const response = await DELETE(
      new NextRequest(`${ORIGIN}/api/contacts/c1`, { method: 'DELETE' }),
      context('c1')
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
  })
})

describe('POST /api/contacts/[id] — restore', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    setResult({ data: null, error: null })
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await POST(
      new NextRequest(`${ORIGIN}/api/contacts/c1`, { method: 'POST' }),
      context('c1')
    )

    expect(response.status).toBe(401)
  })

  it('clears the archive timestamp', async () => {
    const builder = setResult({ data: null, error: null })

    const response = await POST(
      new NextRequest(`${ORIGIN}/api/contacts/c1`, { method: 'POST' }),
      context('c1')
    )

    expect(response.status).toBe(200)
    const update = builder.argsFor('update') as [Record<string, unknown>]
    expect(update[0].deleted_at).toBeNull()
  })

  it('explains an email collision as a 409 rather than a 500', async () => {
    // Restoring a contact whose address was reused violates the partial unique
    // index. That is a conflict the user can act on, not a server fault.
    setResult({ data: null, error: { code: '23505', message: 'duplicate key' } })

    const response = await POST(
      new NextRequest(`${ORIGIN}/api/contacts/c1`, { method: 'POST' }),
      context('c1')
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/already an active contact/i),
    })
  })
})

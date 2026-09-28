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

import { DELETE, PATCH, POST } from './route'

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

describe('PATCH /api/contacts/[id] — archive, restore, remove', () => {
  const LIVE = { id: 'c1', deleted_at: null, removed_at: null }
  const ARCHIVED = { id: 'c1', deleted_at: '2026-09-01T00:00:00.000Z', removed_at: null }

  function patch(body: unknown) {
    return PATCH(
      new NextRequest(`${ORIGIN}/api/contacts/c1`, { method: 'PATCH', body: JSON.stringify(body) }),
      context('c1')
    )
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
  })

  it('refuses an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await patch({ removed: true })).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('removes a live contact by archiving and hiding it, never deleting', async () => {
    const builder = setResult([{ data: LIVE, error: null }, { data: { id: 'c1' }, error: null }])

    expect((await patch({ removed: true })).status).toBe(200)
    expect(builder.argsFor('update')?.[0]).toMatchObject({
      deleted_at: expect.any(String),
      removed_at: expect.any(String),
      removed_by: 'u1',
    })
    expect(builder.argsFor('delete')).toBeUndefined()
  })

  it('keeps the original archive date when removing an archived contact', async () => {
    const builder = setResult([{ data: ARCHIVED, error: null }, { data: { id: 'c1' }, error: null }])

    await patch({ removed: true })

    expect(builder.argsFor('update')?.[0]).toMatchObject({ deleted_at: ARCHIVED.deleted_at })
  })

  it('archives and restores through the same verb', async () => {
    const archiving = setResult([{ data: LIVE, error: null }, { data: { id: 'c1' }, error: null }])
    expect((await patch({ archived: true })).status).toBe(200)
    expect(archiving.argsFor('update')?.[0]).toEqual({ deleted_at: expect.any(String) })

    const restoring = setResult([{ data: ARCHIVED, error: null }, { data: { id: 'c1' }, error: null }])
    expect((await patch({ archived: false })).status).toBe(200)
    expect(restoring.argsFor('update')?.[0]).toEqual({ deleted_at: null })
  })

  it('refuses to restore a live contact', async () => {
    const builder = setResult({ data: LIVE, error: null })

    expect((await patch({ archived: false })).status).toBe(409)
    expect(builder.argsFor('update')).toBeUndefined()
  })

  it('treats a removed contact as not found', async () => {
    setResult({ data: { ...ARCHIVED, removed_at: '2026-09-02T00:00:00.000Z' }, error: null })

    expect((await patch({ archived: false })).status).toBe(404)
  })

  it('explains an email collision on restore as a 409', async () => {
    setResult([{ data: ARCHIVED, error: null }, { data: null, error: { code: '23505', message: 'dup' } }])

    const response = await patch({ archived: false })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('already an active contact')
  })

  it('rejects a body that asks for nothing, or an un-remove', async () => {
    expect((await patch({ name: 'x' })).status).toBe(400)
    expect((await patch({ removed: false })).status).toBe(400)
  })
})

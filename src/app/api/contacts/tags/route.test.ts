/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

import { MAX_SELECTED_IDS } from '@/lib/contacts/query'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

const mockGetSession = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

import { POST } from './route'

const C1 = '11111111-0000-4000-8000-000000000001'
const C2 = '11111111-0000-4000-8000-000000000002'
const T1 = 'aaaaaaaa-0000-4000-8000-000000000001'

function uuid(prefix: string, i: number) {
  return `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`
}

function setup(rpcResult: unknown = { data: { updated: 2 }, error: null }) {
  const db = createDbMock(createQueryBuilderMock())
  db.rpc.mockResolvedValue(rpcResult)
  mockCreateServerClient.mockResolvedValue(db)
  return db
}

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/contacts/tags', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSession.mockResolvedValue({ userId: 'u1', email: 'op@example.com', role: 'operator' })
})

describe('POST /api/contacts/tags', () => {
  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await post({ contactIds: [C1], tagIds: [T1], operation: 'add' })).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('applies the operation in one call and returns how many contacts changed', async () => {
    const db = setup({ data: { updated: 1 }, error: null })

    const response = await post({ contactIds: [C1, C2, C1], tagIds: [T1], operation: 'add' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ updated: 1 })
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(db.rpc).toHaveBeenCalledWith('apply_contact_tags', {
      p_contact_ids: [C1, C2],
      p_tag_ids: [T1],
      p_operation: 'add',
    })
  })

  it('supports removal', async () => {
    const db = setup({ data: { updated: 0 }, error: null })

    await post({ contactIds: [C1], tagIds: [T1], operation: 'remove' })

    expect(db.rpc).toHaveBeenCalledWith('apply_contact_tags', expect.objectContaining({ p_operation: 'remove' }))
  })

  it.each([
    ['an empty selection, which must never mean "everyone"', { contactIds: [], tagIds: [T1], operation: 'add' }],
    ['no tags', { contactIds: [C1], tagIds: [], operation: 'add' }],
    ['an unknown operation', { contactIds: [C1], tagIds: [T1], operation: 'replace' }],
    ['a malformed contact id', { contactIds: ['c1'], tagIds: [T1], operation: 'add' }],
    ['a malformed tag id', { contactIds: [C1], tagIds: ['vip'], operation: 'add' }],
    ['contact ids that are not a list', { contactIds: C1, tagIds: [T1], operation: 'add' }],
    [
      'more contacts than a selection may hold',
      { contactIds: Array.from({ length: MAX_SELECTED_IDS + 1 }, (_, i) => uuid('11111111', i)), tagIds: [T1], operation: 'add' },
    ],
    [
      'more than 50 tags',
      { contactIds: [C1], tagIds: Array.from({ length: 51 }, (_, i) => uuid('aaaaaaaa', i)), operation: 'add' },
    ],
  ])('rejects %s with 400 before calling the database', async (_label, body) => {
    const db = setup()

    expect((await post(body)).status).toBe(400)
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('answers 409 when a selected contact was archived or removed', async () => {
    setup({ data: null, error: { code: 'CRM06', message: 'Some selected contacts were archived.' } })

    expect((await post({ contactIds: [C1], tagIds: [T1], operation: 'add' })).status).toBe(409)
  })

  it('answers 409 when a selected tag no longer exists', async () => {
    setup({ data: null, error: { code: 'CRM07', message: 'A selected tag no longer exists.', hint: 'stale_tags' } })

    expect((await post({ contactIds: [C1], tagIds: [T1], operation: 'add' })).status).toBe(409)
  })

  it('answers 400 when a contact would exceed the tag limit', async () => {
    setup({ data: null, error: { code: 'CRM07', message: 'A contact can have at most 50 tags.', hint: 'tag_limit' } })

    const response = await post({ contactIds: [C1], tagIds: [T1], operation: 'add' })

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/at most 50 tags/)
  })

  it('answers 403 when the database refuses a non-member', async () => {
    setup({ data: null, error: { code: '42501', message: 'An approved CRM member is required.' } })

    expect((await post({ contactIds: [C1], tagIds: [T1], operation: 'add' })).status).toBe(403)
  })

  it('reports anything else as 500', async () => {
    setup({ data: null, error: { message: 'connection reset' } })

    expect((await post({ contactIds: [C1], tagIds: [T1], operation: 'add' })).status).toBe(500)
  })
})

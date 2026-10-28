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

function uuid(i: number) {
  return `11111111-0000-4000-8000-${String(i).padStart(12, '0')}`
}

function setup(rpcResult: unknown = { data: { updated: 2, action: 'archive' }, error: null }) {
  const db = createDbMock(createQueryBuilderMock())
  db.rpc.mockResolvedValue(rpcResult)
  mockCreateServerClient.mockResolvedValue(db)
  return db
}

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/contacts/lifecycle', {
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

describe('POST /api/contacts/lifecycle', () => {
  it('refuses an unauthenticated request before touching the database', async () => {
    mockGetSession.mockResolvedValue(null)

    expect((await post({ contactIds: [C1], action: 'archive' })).status).toBe(401)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
  })

  it('archives the selection in one call and returns how many changed', async () => {
    const db = setup({ data: { updated: 2, action: 'archive' }, error: null })

    const response = await post({ contactIds: [C1, C2, C1.toUpperCase()], action: 'archive' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ updated: 2, action: 'archive' })
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(db.rpc).toHaveBeenCalledWith('set_contacts_lifecycle', {
      p_contact_ids: [C1, C2],
      p_action: 'archive',
    })
  })

  it('removes the selection the same way', async () => {
    const db = setup({ data: { updated: 1, action: 'remove' }, error: null })

    const response = await post({ contactIds: [C1], action: 'remove' })

    expect(response.status).toBe(200)
    expect(db.rpc).toHaveBeenCalledWith('set_contacts_lifecycle', { p_contact_ids: [C1], p_action: 'remove' })
  })

  it.each([
    ['an empty selection, which must never mean "everyone"', { contactIds: [], action: 'archive' }],
    ['an unknown action', { contactIds: [C1], action: 'delete' }],
    ['a restore, which is not a bulk action', { contactIds: [C1], action: 'restore' }],
    ['a malformed contact id', { contactIds: ['c1'], action: 'archive' }],
    ['contact ids that are not a list', { contactIds: C1, action: 'archive' }],
    [
      'more contacts than a selection may hold',
      { contactIds: Array.from({ length: MAX_SELECTED_IDS + 1 }, (_, i) => uuid(i)), action: 'archive' },
    ],
  ])('rejects %s with 400 before calling the database', async (_label, body) => {
    const db = setup()

    expect((await post(body)).status).toBe(400)
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('answers 409 when a selected contact was archived or removed meanwhile', async () => {
    setup({ data: null, error: { code: 'CRM06', message: 'Some selected contacts were archived or no longer exist.' } })

    const response = await post({ contactIds: [C1], action: 'archive' })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/archived or no longer exist/)
  })

  it('answers 409 with the rule when an archive rule refuses a contact', async () => {
    setup({ data: null, error: { code: 'CRM01', message: 'Contact is in a campaign that is sending.' } })

    const response = await post({ contactIds: [C1], action: 'remove' })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/campaign that is sending/)
  })

  it('answers 403 when the database refuses a non-member', async () => {
    setup({ data: null, error: { code: '42501', message: 'An approved CRM member is required.' } })

    expect((await post({ contactIds: [C1], action: 'archive' })).status).toBe(403)
  })

  it('reports anything else as 500', async () => {
    setup({ data: null, error: { message: 'connection reset' } })

    const response = await post({ contactIds: [C1], action: 'archive' })

    expect(response.status).toBe(500)
    expect((await response.json()).error).toMatch(/Could not archive contacts/)
  })
})

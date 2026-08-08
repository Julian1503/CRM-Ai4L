/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockGetSession = jest.fn()
const mockSync = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/emailOctopus', () => ({
  syncContactToEmailOctopus: (...args: unknown[]) => mockSync(...args),
}))

import { POST } from './route'

function post(body: unknown) {
  return POST(
    new NextRequest('https://crm.example.com/api/integrations/emailoctopus/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
}

const validPayload = {
  apiKey: 'eo-key',
  listId: 'list-1',
  contacts: [
    { email: 'a@example.com', firstName: 'A', lastName: 'One', subscribedToNewsletter: true },
    { email: 'b@example.com', firstName: 'B', lastName: 'Two', subscribedToNewsletter: false },
  ],
}

describe('POST /api/integrations/emailoctopus/sync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    mockSync.mockResolvedValue(undefined)
  })

  it('refuses an unauthenticated caller', async () => {
    // Unlike the webhook, this acts on behalf of a user and is not exempt.
    mockGetSession.mockResolvedValue(null)

    expect((await post(validPayload)).status).toBe(401)
    expect(mockSync).not.toHaveBeenCalled()
  })

  it('syncs each contact with the right subscription status', async () => {
    const response = await post(validPayload)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ syncedCount: 2, errorsCount: 0 })
    expect(mockSync).toHaveBeenNthCalledWith(1, 'eo-key', 'list-1', 'a@example.com', 'A', 'One', 'SUBSCRIBED')
    expect(mockSync).toHaveBeenNthCalledWith(2, 'eo-key', 'list-1', 'b@example.com', 'B', 'Two', 'UNSUBSCRIBED')
  })

  it.each([
    ['no api key', { listId: 'l', contacts: [] }],
    ['no list id', { apiKey: 'k', contacts: [] }],
    ['contacts not an array', { apiKey: 'k', listId: 'l', contacts: 'nope' }],
  ])('rejects a payload with %s', async (_label, payload) => {
    expect((await post(payload)).status).toBe(400)
  })

  it('skips entries with no email rather than calling the provider with blanks', async () => {
    const response = await post({
      ...validPayload,
      contacts: [{ email: '' }, { notAnEmail: true }, validPayload.contacts[0]],
    })

    await expect(response.json()).resolves.toMatchObject({ syncedCount: 1, skippedCount: 2 })
  })

  it('continues after one contact fails', async () => {
    // One bad address must not abort a whole sync run.
    mockSync
      .mockRejectedValueOnce(new Error('Invalid email address'))
      .mockResolvedValueOnce(undefined)

    const response = await post(validPayload)
    const body = await response.json()

    expect(body).toMatchObject({ syncedCount: 1, errorsCount: 1 })
    expect(body.errors[0]).toMatchObject({ email: 'a@example.com' })
  })

  it('marks the response uncacheable, since errors echo email addresses', async () => {
    const response = await post(validPayload)

    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('surfaces a malformed body as a server error rather than crashing', async () => {
    expect((await post('not json')).status).toBe(500)
  })
})

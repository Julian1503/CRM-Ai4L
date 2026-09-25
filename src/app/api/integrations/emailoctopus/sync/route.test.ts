/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockGetSession = jest.fn()
const mockSync = jest.fn()
const mockCreateServerClient = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/emailOctopus', () => ({
  syncContactToEmailOctopus: (...args: unknown[]) => mockSync(...args),
}))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

/**
 * A contacts table of `count` rows, served through the chained query builder in
 * whatever `.range()` windows the route asks for.
 */
function stubContactsTable(count: number) {
  const ranges: Array<[number, number]> = []

  const rows = Array.from({ length: count }, (unused, index) => ({
    email: `contact-${index}@example.com`,
    first_name: `First${index}`,
    last_name: `Last${index}`,
    subscribed_to_newsletter: index % 2 === 0,
  }))

  const builder: Record<string, unknown> = {}
  const chain = () => builder

  builder.select = chain
  builder.order = chain
  builder.range = (from: number, to: number) => {
    ranges.push([from, to])
    return builder
  }
  builder.then = (resolve: (value: unknown) => unknown) => {
    const [from, to] = ranges[ranges.length - 1]
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null }).then(resolve)
  }

  mockCreateServerClient.mockResolvedValue({ from: jest.fn(() => builder) })

  return { ranges }
}

import { POST, SYNC_CHUNK_SIZE } from './route'

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

  it('syncs every contact when the caller omits the list', async () => {
    // The browser only holds the page of contacts on screen, so a full sync has to be
    // gathered server-side rather than posted up.
    const { ranges } = stubContactsTable(3)

    const response = await post({ apiKey: 'eo-key', listId: 'list-1' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ syncedCount: 3, skippedCount: 0 })
    expect(mockSync).toHaveBeenCalledTimes(3)
    expect(ranges[0]).toEqual([0, SYNC_CHUNK_SIZE])
  })

  it('returns a continuation cursor instead of processing the whole database in one request', async () => {
    const { ranges } = stubContactsTable(125)

    const first = await post({ apiKey: 'eo-key', listId: 'list-1' })
    const firstBody = await first.json()
    const second = await post({
      apiKey: 'eo-key',
      listId: 'list-1',
      offset: firstBody.nextOffset,
    })

    expect(firstBody).toMatchObject({
      syncedCount: SYNC_CHUNK_SIZE,
      hasMore: true,
      nextOffset: SYNC_CHUNK_SIZE,
    })
    await expect(second.json()).resolves.toMatchObject({
      syncedCount: SYNC_CHUNK_SIZE,
      hasMore: true,
      nextOffset: SYNC_CHUNK_SIZE * 2,
    })
    expect(ranges).toEqual([
      [0, SYNC_CHUNK_SIZE],
      [SYNC_CHUNK_SIZE, SYNC_CHUNK_SIZE * 2],
    ])
  })

  it('still accepts an explicit contact list for a single-contact sync', async () => {
    const response = await post({
      apiKey: 'eo-key',
      listId: 'list-1',
      contacts: [{ email: 'one@example.com', subscribedToNewsletter: true }],
    })

    expect(response.status).toBe(200)
    expect(mockCreateServerClient).not.toHaveBeenCalled()
    expect(mockSync).toHaveBeenCalledTimes(1)
  })

  it('refuses an unauthenticated caller', async () => {
    // Unlike the webhook, this acts on behalf of a user and is not exempt.
    mockGetSession.mockResolvedValue(null)

    expect((await post(validPayload)).status).toBe(401)
    expect(mockSync).not.toHaveBeenCalled()
  })

  it('keeps a courses-only contact subscribed on the provider list', async () => {
    // The list status is one switch and answers "may we email this person at all". Read
    // as the newsletter flag alone, it would push a contact who takes courses but not
    // the newsletter as UNSUBSCRIBED — and EmailOctopus then refuses to queue the course
    // automation for them, making the second consent unusable.
    const response = await post({
      apiKey: 'eo-key',
      listId: 'list-1',
      contacts: [
        {
          email: 'courses@example.com',
          firstName: 'C',
          lastName: 'Only',
          subscribedToNewsletter: false,
          subscribedToPrograms: true,
        },
      ],
    })

    expect(response.status).toBe(200)
    expect(mockSync).toHaveBeenCalledWith(
      'eo-key',
      'list-1',
      'courses@example.com',
      'C',
      'Only',
      'SUBSCRIBED',
      // Which consent they actually hold cannot be carried by the list status, so it
      // travels as fields — that is what a natively-sent newsletter segments on.
      expect.objectContaining({ fields: { Newsletter: 'no', Courses: 'yes' } })
    )
  })

  it('syncs each contact with the right subscription status', async () => {
    const response = await post(validPayload)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ syncedCount: 2, errorsCount: 0 })
    expect(mockSync).toHaveBeenNthCalledWith(
      1, 'eo-key', 'list-1', 'a@example.com', 'A', 'One', 'SUBSCRIBED', expect.anything()
    )
    expect(mockSync).toHaveBeenNthCalledWith(
      2, 'eo-key', 'list-1', 'b@example.com', 'B', 'Two', 'UNSUBSCRIBED', expect.anything()
    )
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

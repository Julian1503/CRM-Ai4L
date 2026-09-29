/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockGetSession = jest.fn()
const mockSync = jest.fn()
const mockCreateServerClient = jest.fn()
const mockLoadCredentials = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/emailOctopus', () => ({
  syncContactToEmailOctopus: (...args: unknown[]) => mockSync(...args),
}))
// Read server-side with the service role since audit H1; never from the request.
jest.mock('@/lib/marketing/providers/credentials', () => ({
  loadEmailOctopusCredentials: () => mockLoadCredentials(),
}))
jest.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => mockCreateServerClient(),
}))

/**
 * A contacts table of `count` rows, served through the chained query builder in
 * whatever `.range()` windows the route asks for.
 */
type StubRow = {
  id?: string
  email: string
  first_name?: string
  last_name?: string
  subscribed_to_newsletter?: boolean
  subscribed_to_programs?: boolean
}

function stubContactsTable(countOrRows: number | StubRow[]) {
  const ranges: Array<[number, number]> = []

  const rows: StubRow[] = Array.isArray(countOrRows)
    ? countOrRows
    : Array.from({ length: countOrRows }, (unused, index) => ({
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

describe('POST /api/integrations/emailoctopus/sync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    mockSync.mockResolvedValue(undefined)
    mockLoadCredentials.mockResolvedValue({ apiKey: 'eo-key', listId: 'list-1' })
  })

  it('syncs every contact when the caller omits the list', async () => {
    // The browser only holds the page of contacts on screen, so a full sync has to be
    // gathered server-side rather than posted up.
    const { ranges } = stubContactsTable(3)

    const response = await post({})

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ syncedCount: 3 })
    expect(mockSync).toHaveBeenCalledTimes(3)
    expect(ranges[0]).toEqual([0, SYNC_CHUNK_SIZE])
  })

  it('returns a continuation cursor instead of processing the whole database in one request', async () => {
    const { ranges } = stubContactsTable(125)

    const first = await post({})
    const firstBody = await first.json()
    const second = await post({
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

  it('refuses a contact list from the caller: the server reads the database itself (H5)', async () => {
    // Accepting one let any caller push arbitrary consent state for arbitrary addresses.
    const response = await post({
      contacts: [{ email: 'one@example.com', subscribedToNewsletter: true }],
    })

    expect(response.status).toBe(400)
    expect(mockSync).not.toHaveBeenCalled()
  })

  it('refuses an unauthenticated caller', async () => {
    // Unlike the webhook, this acts on behalf of a user and is not exempt.
    mockGetSession.mockResolvedValue(null)

    expect((await post({})).status).toBe(401)
    expect(mockSync).not.toHaveBeenCalled()
  })

  it('keeps a courses-only contact subscribed on the provider list', async () => {
    // The list status is one switch and answers "may we email this person at all". Read
    // as the newsletter flag alone, it would push a contact who takes courses but not
    // the newsletter as UNSUBSCRIBED — and EmailOctopus then refuses to queue the course
    // automation for them, making the second consent unusable.
    stubContactsTable([
      { email: 'courses@example.com', first_name: 'C', last_name: 'Only', subscribed_to_newsletter: false, subscribed_to_programs: true },
    ])

    const response = await post({})

    expect(response.status).toBe(200)
    expect(mockSync).toHaveBeenCalledWith(
      'eo-key',
      'list-1',
      'courses@example.com',
      'C',
      'Only',
      'SUBSCRIBED',
      // Which consent they actually hold travels as fields — that is what a
      // natively-sent newsletter segments on.
      expect.objectContaining({ fields: { Newsletter: 'no', Courses: 'yes' } })
    )
  })

  it('syncs each contact with the right subscription status', async () => {
    stubContactsTable([
      { email: 'a@example.com', first_name: 'A', last_name: 'One', subscribed_to_newsletter: true },
      { email: 'b@example.com', first_name: 'B', last_name: 'Two', subscribed_to_newsletter: false },
    ])

    const response = await post({})

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ syncedCount: 2, errorsCount: 0 })
    expect(mockSync).toHaveBeenNthCalledWith(
      1, 'eo-key', 'list-1', 'a@example.com', 'A', 'One', 'SUBSCRIBED', expect.anything()
    )
    expect(mockSync).toHaveBeenNthCalledWith(
      2, 'eo-key', 'list-1', 'b@example.com', 'B', 'Two', 'UNSUBSCRIBED', expect.anything()
    )
  })

  it('refuses when EmailOctopus is not configured server-side', async () => {
    stubContactsTable(2)
    mockLoadCredentials.mockResolvedValue(null)

    expect((await post({})).status).toBe(409)
    expect(mockSync).not.toHaveBeenCalled()
  })

  it('ignores a key and list supplied by the caller', async () => {
    // A caller-supplied key would let anyone push the CRM's contacts to their own list.
    stubContactsTable([{ email: 'a@example.com', first_name: 'A', last_name: 'One', subscribed_to_newsletter: true }])

    await post({ apiKey: 'attacker-key', listId: 'attacker-list' })

    expect(mockSync).toHaveBeenCalledWith(
      'eo-key', 'list-1', 'a@example.com', 'A', 'One', 'SUBSCRIBED', expect.anything()
    )
  })

  it('skips rows with no email rather than calling the provider with blanks', async () => {
    stubContactsTable([{ email: '' }, { email: 'a@example.com', subscribed_to_newsletter: true }])

    await expect((await post({})).json()).resolves.toMatchObject({ syncedCount: 1 })
    expect(mockSync).toHaveBeenCalledTimes(1)
  })

  it('continues after one contact fails', async () => {
    // One bad address must not abort a whole sync run.
    stubContactsTable([
      { email: 'a@example.com', subscribed_to_newsletter: true },
      { email: 'b@example.com', subscribed_to_newsletter: true },
    ])
    mockSync
      .mockRejectedValueOnce(new Error('Invalid email address'))
      .mockResolvedValueOnce(undefined)

    const body = await (await post({})).json()

    expect(body).toMatchObject({ syncedCount: 1, errorsCount: 1 })
    expect(body.errors[0]).toMatchObject({ email: 'a@example.com' })
  })

  it('marks the response uncacheable, since errors echo email addresses', async () => {
    stubContactsTable(1)
    const response = await post({})

    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('treats a malformed body as a plain full sync request', async () => {
    stubContactsTable(1)
    expect((await post('not json')).status).toBe(200)
  })
})

import { getRetryDelayMs, syncContactToEmailOctopus } from './emailOctopus'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

const sleep = jest.fn().mockResolvedValue(undefined)

function ok() {
  return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: 'eo-1' }) }
}

function failure(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => body,
  }
}

function sync(status: 'SUBSCRIBED' | 'UNSUBSCRIBED' = 'SUBSCRIBED', maxAttempts = 3) {
  return syncContactToEmailOctopus(
    'eo-api-key',
    'list-1',
    'grace@example.com',
    'Grace',
    'Hopper',
    status,
    { maxAttempts, sleep }
  )
}

describe('syncContactToEmailOctopus', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('v2 contract', () => {
    it('upserts against the v2 contacts endpoint', async () => {
      // PUT, not POST. `POST /lists/{id}/contacts` creates, and answers 409 for an
      // address already on the list -- which, for a full sync of an established list,
      // is nearly every contact. A 409 is a 4xx, so the retry logic correctly treats
      // it as fatal and the sync dies on its first existing contact.
      //
      // `PUT /lists/{id}/contacts` is create-or-update, verified against the live API.
      // It is also what the campaign send path already uses (marketing/providers).
      mockFetch.mockResolvedValueOnce(ok())

      await sync()

      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.emailoctopus.com/lists/list-1/contacts')
      expect(init.method).toBe('PUT')
    })

    it('authenticates with a bearer token, not a key in the body', async () => {
      // v1.6 put api_key in the JSON body, which leaks it into request logs and
      // proxies. v2 uses the Authorization header.
      mockFetch.mockResolvedValueOnce(ok())

      await sync()

      const [, init] = mockFetch.mock.calls[0]
      expect(init.headers.Authorization).toBe('Bearer eo-api-key')
      expect(init.body).not.toContain('api_key')
      expect(init.body).not.toContain('eo-api-key')
    })

    it('sends the lowercase status v2 expects', async () => {
      mockFetch.mockResolvedValueOnce(ok())

      await sync('UNSUBSCRIBED')

      const [, init] = mockFetch.mock.calls[0]
      expect(JSON.parse(init.body).status).toBe('unsubscribed')
    })

    it('sends the contact fields', async () => {
      mockFetch.mockResolvedValueOnce(ok())

      await sync()

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).toMatchObject({
        email_address: 'grace@example.com',
        fields: { FirstName: 'Grace', LastName: 'Hopper' },
      })
    })

    it('url-encodes the list id', async () => {
      mockFetch.mockResolvedValueOnce(ok())

      await syncContactToEmailOctopus('k', 'list/../evil', 'a@b.co', 'A', 'B', 'SUBSCRIBED', {
        sleep,
      })

      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://api.emailoctopus.com/lists/list%2F..%2Fevil/contacts'
      )
    })

    it('resolves without throwing on success', async () => {
      mockFetch.mockResolvedValueOnce(ok())

      await expect(sync()).resolves.toBeUndefined()
    })
  })

  describe('rate limiting', () => {
    it('retries a 429 and succeeds', async () => {
      mockFetch.mockResolvedValueOnce(failure(429)).mockResolvedValueOnce(ok())

      await expect(sync()).resolves.toBeUndefined()
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('honours Retry-After', async () => {
      mockFetch
        .mockResolvedValueOnce(failure(429, {}, { 'retry-after': '7' }))
        .mockResolvedValueOnce(ok())

      await sync()

      expect(sleep).toHaveBeenCalledWith(7000)
    })

    it('backs off exponentially when Retry-After is absent', async () => {
      mockFetch
        .mockResolvedValueOnce(failure(429))
        .mockResolvedValueOnce(failure(429))
        .mockResolvedValueOnce(ok())

      await sync()

      expect(sleep).toHaveBeenNthCalledWith(1, 500)
      expect(sleep).toHaveBeenNthCalledWith(2, 1000)
    })

    it('gives up after the attempt limit', async () => {
      mockFetch.mockResolvedValue(failure(429, { detail: 'Too many requests' }))

      await expect(sync('SUBSCRIBED', 3)).rejects.toThrow(/Too many requests/)
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('retries a 5xx', async () => {
      mockFetch.mockResolvedValueOnce(failure(503)).mockResolvedValueOnce(ok())

      await expect(sync()).resolves.toBeUndefined()
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('errors', () => {
    it('does not retry a 4xx', async () => {
      // Retrying a bad request burns quota and delays the real error.
      mockFetch.mockResolvedValue(failure(400, { detail: 'Invalid email address' }))

      await expect(sync()).rejects.toThrow(/Invalid email address/)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('surfaces a nested v1-style error message', async () => {
      mockFetch.mockResolvedValue(failure(422, { error: { message: 'MEMBER_EXISTS_WITH_EMAIL' } }))

      await expect(sync()).rejects.toThrow(/MEMBER_EXISTS_WITH_EMAIL/)
    })

    it('falls back to the status code for a non-JSON body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        headers: new Headers(),
        json: async () => {
          throw new Error('not json')
        },
      })

      await expect(sync('SUBSCRIBED', 1)).rejects.toThrow(/HTTP Error 502/)
    })
  })
})

describe('getRetryDelayMs', () => {
  it('uses Retry-After when present', () => {
    expect(getRetryDelayMs('12', 1)).toBe(12000)
  })

  it.each([null, '', 'soon', '0', '-5'])('backs off exponentially for %p', (header) => {
    expect(getRetryDelayMs(header, 1)).toBe(500)
    expect(getRetryDelayMs(header, 3)).toBe(2000)
  })
})

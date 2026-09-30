/**
 * Test-only fetch double for the catalogue components.
 *
 * Routes a request by method and path to a handler returning `{ status, body }`, and
 * records every call so tests can assert what was sent.
 */

export type MockResponse = { status?: number; body?: unknown }

export type FetchCall = { method: string; url: URL; body: unknown }

type Handler = (call: FetchCall) => MockResponse | Promise<MockResponse>

export function installFetchRouter(routes: Record<string, Handler>): {
  calls: FetchCall[]
  fetchMock: jest.Mock
} {
  const calls: FetchCall[] = []

  const fetchMock = jest.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'https://crm.test')
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const call = { method, url, body }
    calls.push(call)

    const handler = routes[`${method} ${url.pathname}`]

    const { status = 200, body: responseBody = {} } = handler
      ? await handler(call)
      : { status: 500, body: { error: `No mock for ${method} ${url.pathname}` } }

    // A minimal Response: jsdom's polyfilled Response has no `ok`.
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
    }
  })

  global.fetch = fetchMock as unknown as typeof fetch

  return { calls, fetchMock }
}

/** Builds the paginated envelope every catalogue list endpoint returns. */
export function page<T>(key: string, items: T[], total = items.length, hasMore = false) {
  return { [key]: items, total, page: 1, pageSize: 20, hasMore }
}

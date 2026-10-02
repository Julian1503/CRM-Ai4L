/** @jest-environment node */
import { verifyWorkerRequest } from '@/lib/content-studio/workerAuth'

import { EngineError, exchangeCode, parseEngineAccount, requestAuthorizeUrl } from './engineClient'

const SECRET = 's'.repeat(40)
const ENV = { CONTENT_ENGINE_URL: 'https://engine.test/', CONTENT_ENGINE_SECRET: SECRET }
const ORIGINAL_ENV = process.env
const TOKEN = 'live-token-must-never-leak'

const fetchMock = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...ORIGINAL_ENV, CONTENT_WORKER_SECRET: 'w'.repeat(40) }
  global.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

const ACCOUNT = {
  platform: 'facebook',
  externalId: 'page-1',
  displayName: 'AI4L',
  authorKind: 'page',
  scopes: ['pages_manage_posts', 3],
  accessToken: TOKEN,
}

describe('requestAuthorizeUrl', () => {
  it('signs the exact path and body with the worker secret', async () => {
    reply(200, { url: 'https://www.facebook.com/v23.0/dialog/oauth?x=1' })

    const url = await requestAuthorizeUrl('meta', { state: 'st'.repeat(10), redirectUri: 'https://crm.test/cb', options: {} }, ENV)

    expect(url).toBe('https://www.facebook.com/v23.0/dialog/oauth?x=1')
    const [target, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { headers: Record<string, string> }]
    expect(String(target)).toBe('https://engine.test/v1/oauth/meta/authorize-url')
    expect(
      verifyWorkerRequest({
        method: 'POST',
        path: '/v1/oauth/meta/authorize-url',
        rawBody: init.body as string,
        timestampHeader: init.headers['x-content-worker-timestamp'],
        signatureHeader: init.headers['x-content-worker-signature'],
        secret: SECRET,
      })
    ).toEqual({ ok: true })
  })

  it('keeps a base path of the engine URL in the signed path', async () => {
    reply(200, { url: 'https://x.test/' })
    await requestAuthorizeUrl('mock', { state: 's', redirectUri: 'r', options: {} }, { CONTENT_ENGINE_URL: 'https://gw.test/engine', CONTENT_ENGINE_SECRET: SECRET })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://gw.test/engine/v1/oauth/mock/authorize-url')
  })

  it.each([
    ['no engine URL', { CONTENT_ENGINE_SECRET: SECRET }, 'engine_not_configured'],
    ['an invalid engine URL', { CONTENT_ENGINE_URL: 'not a url', CONTENT_ENGINE_SECRET: SECRET }, 'engine_not_configured'],
    ['no engine secret', { CONTENT_ENGINE_URL: 'https://engine.test' }, 'engine_not_configured'],
    ['a short engine secret', { CONTENT_ENGINE_URL: 'https://engine.test', CONTENT_ENGINE_SECRET: 'short' }, 'engine_not_configured'],
  ])('fails closed with %s', async (_label, env, code) => {
    await expect(requestAuthorizeUrl('meta', { state: 's', redirectUri: 'r', options: {} }, env)).rejects.toMatchObject({ code })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never signs with the worker secret', async () => {
    reply(200, { url: 'https://x.test/' })
    await requestAuthorizeUrl('meta', { state: 's', redirectUri: 'r', options: {} }, ENV)
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { headers: Record<string, string> }]
    expect(
      verifyWorkerRequest({
        method: 'POST',
        path: '/v1/oauth/meta/authorize-url',
        rawBody: init.body as string,
        timestampHeader: init.headers['x-content-worker-timestamp'],
        signatureHeader: init.headers['x-content-worker-signature'],
        secret: 'w'.repeat(40),
      })
    ).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it.each([
    [500, 'engine_unreachable'],
    [400, 'engine_refused'],
  ])('maps HTTP %s to %s', async (status, code) => {
    reply(status, { error: 'nope' })
    await expect(requestAuthorizeUrl('meta', { state: 's', redirectUri: 'r', options: {} }, ENV)).rejects.toMatchObject({ code, status })
  })

  it('maps a network failure and a malformed body', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(requestAuthorizeUrl('meta', { state: 's', redirectUri: 'r', options: {} }, ENV)).rejects.toMatchObject({ code: 'engine_unreachable' })

    reply(200, { url: 'javascript:alert(1)' })
    await expect(requestAuthorizeUrl('meta', { state: 's', redirectUri: 'r', options: {} }, ENV)).rejects.toMatchObject({ code: 'engine_invalid_response' })

    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }))
    await expect(requestAuthorizeUrl('meta', { state: 's', redirectUri: 'r', options: {} }, ENV)).rejects.toMatchObject({ code: 'engine_invalid_response' })
  })
})

describe('exchangeCode', () => {
  it('returns only well-formed accounts', async () => {
    reply(200, {
      accounts: [
        ACCOUNT,
        { ...ACCOUNT, platform: 'instagram', authorKind: 'page' },
        { ...ACCOUNT, accessToken: '' },
        { ...ACCOUNT, platform: 'linkedin', authorKind: 'member', externalId: 'p', refreshToken: 'r', expiresAt: '2026-12-01T00:00:00Z' },
      ],
    })

    const accounts = await exchangeCode('meta', { code: 'c', redirectUri: 'r', options: {} }, ENV)

    expect(accounts).toEqual([
      { ...ACCOUNT, scopes: ['pages_manage_posts'], refreshToken: null, expiresAt: null },
      { ...ACCOUNT, platform: 'linkedin', authorKind: 'member', externalId: 'p', scopes: ['pages_manage_posts'], refreshToken: 'r', expiresAt: '2026-12-01T00:00:00Z' },
    ])
  })

  it('refuses a response without an accounts array', async () => {
    reply(200, { accounts: 'nope' })
    await expect(exchangeCode('meta', { code: 'c', redirectUri: 'r', options: {} }, ENV)).rejects.toBeInstanceOf(EngineError)
  })

  it('never puts a token in an error message', async () => {
    reply(400, { error: `bad code, token=${TOKEN}` })
    const error = await exchangeCode('meta', { code: 'c', redirectUri: 'r', options: {} }, ENV).catch((caught: Error) => caught)
    expect(String((error as Error).message)).not.toContain(TOKEN)
  })
})

describe('parseEngineAccount', () => {
  it('rejects non-objects, oversize ids and invalid expiry dates', () => {
    expect(parseEngineAccount(null)).toBeNull()
    expect(parseEngineAccount({ ...ACCOUNT, externalId: 'x'.repeat(201) })).toBeNull()
    expect(parseEngineAccount({ ...ACCOUNT, platform: 'tiktok' })).toBeNull()
    expect(parseEngineAccount({ ...ACCOUNT, expiresAt: 'soon', scopes: 'x' })).toMatchObject({ expiresAt: null, scopes: [] })
  })
})

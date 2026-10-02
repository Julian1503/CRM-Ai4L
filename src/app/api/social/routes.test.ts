/** @jest-environment node */
import { NextRequest } from 'next/server'

const mockGetSession = jest.fn()
const mockServerClient = jest.fn()
const mockAdmin = jest.fn()
const mockSaveSecrets = jest.fn()
const mockLoadTokens = jest.fn()
const mockPublishAsset = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: () => mockServerClient() }))
jest.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockAdmin() }))
jest.mock('@/lib/social/credentials', () => ({
  saveAccountSecrets: (...args: unknown[]) => mockSaveSecrets(...args),
  loadAccountTokens: (...args: unknown[]) => mockLoadTokens(...args),
}))
jest.mock('@/lib/content-studio/assets', () => ({ publishAsset: (...args: unknown[]) => mockPublishAsset(...args) }))

import {
  accountRow,
  assetRow,
  brandRow,
  IDS,
  publicationRow,
  revisionRow,
  SESSION,
  variantRow,
} from '@/lib/content-studio/testFixtures'
import { hashState } from '@/lib/social/oauthState'
import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

import { PATCH as patchAccount } from './accounts/[id]/route'
import { GET as listAccounts } from './accounts/route'
import { GET as callback } from './oauth/[provider]/callback/route'
import { POST as start } from './oauth/[provider]/start/route'
import { POST as preflight } from './publications/preflight/route'
import { GET as listPublications, POST as publish } from './publications/route'

const ORIGIN = 'https://crm.example.com'
const ORIGINAL_ENV = process.env
const ADMIN_SESSION = { ...SESSION, role: 'admin' as const }
const TOKEN = 'live-token-must-never-leak'
const CODE = 'provider-code-must-never-leak'
const STATE = 'S'.repeat(43)
const fetchMock = jest.fn()

type Tables = Record<string, unknown>

function dbWith(tables: Tables, rpc: unknown = { data: null, error: null }) {
  const builders: Record<string, QueryBuilderMock> = {}
  const db = createDbMock((table: string) => (builders[table] ??= createQueryBuilderMock(tables[table] ?? { data: null, error: null })))
  db.rpc.mockImplementation(async () => rpc)
  return { db, builders }
}

function req(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const { method = 'GET', body, headers = {} } = init
  return new NextRequest(`${ORIGIN}/api/social${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}

const provider = (name: string) => ({ params: Promise.resolve({ provider: name }) })
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) })
const location = (response: Response) => new URL(response.headers.get('location') ?? '')

beforeEach(() => {
  jest.clearAllMocks()
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    CONTENT_STUDIO_ENABLED: 'true',
    CONTENT_SOCIAL_PLATFORMS: 'facebook,instagram,linkedin',
    CONTENT_ENGINE_URL: 'https://engine.test',
    CONTENT_ENGINE_SECRET: 'e'.repeat(40),
    NEXT_PUBLIC_APP_URL: '',
  }
  global.fetch = fetchMock as unknown as typeof fetch
  mockGetSession.mockResolvedValue(ADMIN_SESSION)
})

afterEach(() => {
  jest.restoreAllMocks()
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

describe('authentication', () => {
  it.each([
    ['GET accounts', () => listAccounts()],
    ['PATCH account', () => patchAccount(req(`/accounts/${IDS.account}`, { method: 'PATCH', body: { action: 'disconnect' } }), idCtx(IDS.account))],
    ['POST start', () => start(req('/oauth/meta/start', { method: 'POST' }), provider('meta'))],
    ['GET publications', () => listPublications(req('/publications'))],
    ['POST publications', () => publish(req('/publications', { method: 'POST', body: {} }))],
    ['POST preflight', () => preflight(req('/publications/preflight', { method: 'POST', body: {} }))],
  ])('%s refuses an unauthenticated request before touching the database', async (_label, call) => {
    mockGetSession.mockResolvedValue(null)
    const response = await call()
    expect(response.status).toBe(401)
    expect(mockServerClient).not.toHaveBeenCalled()
    expect(mockAdmin).not.toHaveBeenCalled()
  })

  it('the callback sends an unauthenticated browser back to Settings without touching the database', async () => {
    mockGetSession.mockResolvedValue(null)
    const response = await callback(req(`/oauth/meta/callback?code=${CODE}&state=${STATE}`), provider('meta'))
    expect(response.status).toBe(303)
    expect(location(response).searchParams.get('reason')).toBe('not_authorised')
    expect(mockAdmin).not.toHaveBeenCalled()
  })

  it.each([
    ['PATCH account', () => patchAccount(req(`/accounts/${IDS.account}`, { method: 'PATCH', body: { action: 'disconnect' } }), idCtx(IDS.account))],
    ['POST start', () => start(req('/oauth/meta/start', { method: 'POST' }), provider('meta'))],
  ])('%s is administrator-only', async (_label, call) => {
    mockGetSession.mockResolvedValue(SESSION)
    expect((await call()).status).toBe(403)
    expect(mockAdmin).not.toHaveBeenCalled()
  })

  it('the callback refuses an operator', async () => {
    mockGetSession.mockResolvedValue(SESSION)
    const response = await callback(req(`/oauth/meta/callback?code=${CODE}&state=${STATE}`), provider('meta'))
    expect(location(response).searchParams.get('reason')).toBe('not_authorised')
    expect(mockAdmin).not.toHaveBeenCalled()
  })
})

describe('accounts', () => {
  it('lists accounts and the enabled platforms, uncacheable and token-free', async () => {
    const { db } = dbWith({ social_accounts: { data: [accountRow()], error: null } })
    mockServerClient.mockResolvedValue(db)
    process.env.CONTENT_SOCIAL_PLATFORMS = 'linkedin'

    const response = await listAccounts()
    const body = await response.json()

    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(body.enabledPlatforms).toEqual(['linkedin'])
    expect(body.accounts[0]).not.toHaveProperty('accessToken')
  })

  it('reports a database failure as a 500 without internals', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockServerClient.mockResolvedValue(dbWith({ social_accounts: { data: null, error: { message: 'relation secret_x' } } }).db)
    const response = await listAccounts()
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('secret_x')
  })

  it('disconnects without deleting', async () => {
    const { db, builders } = dbWith({ social_accounts: { data: accountRow({ status: 'disconnected' }), error: null } })
    mockAdmin.mockReturnValue(db)

    const response = await patchAccount(req(`/accounts/${IDS.account}`, { method: 'PATCH', body: { action: 'disconnect' } }), idCtx(IDS.account))

    expect(response.status).toBe(200)
    expect((await response.json()).account.status).toBe('disconnected')
    expect(builders.social_accounts.allFor('delete')).toHaveLength(0)
  })

  it.each([
    ['an unknown action', IDS.account, { action: 'delete' }, 400],
    ['a malformed id', 'not-a-uuid', { action: 'disconnect' }, 404],
  ])('refuses %s', async (_label, id, body, status) => {
    mockAdmin.mockReturnValue(dbWith({}).db)
    expect((await patchAccount(req(`/accounts/${id}`, { method: 'PATCH', body }), idCtx(id))).status).toBe(status)
  })
})

describe('OAuth start', () => {
  function startDbs() {
    const member = dbWith({ content_brand_profiles: { data: brandRow(), error: null } })
    const admin = dbWith({ social_oauth_states: { data: null, error: null } })
    mockServerClient.mockResolvedValue(member.db)
    mockAdmin.mockReturnValue(admin.db)
    return admin
  }

  it('stores a hashed state and redirects to the consent URL the engine built', async () => {
    const admin = startDbs()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ url: 'https://www.linkedin.com/oauth/v2/authorization?x=1' }), { status: 200 }))

    const response = await start(
      req('/oauth/linkedin/start', { method: 'POST', body: 'authorKind=member', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN } }),
      provider('linkedin')
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://www.linkedin.com/oauth/v2/authorization?x=1')
    const [row] = admin.builders.social_oauth_states.argsFor('insert') as [Record<string, unknown>]
    expect(row).toMatchObject({ provider: 'linkedin', actor_id: ADMIN_SESSION.userId, options: { authorKind: 'member' } })
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sent.redirectUri).toBe(`${ORIGIN}/api/social/oauth/linkedin/callback`)
    expect(row.state_hash).toBe(hashState(sent.state))
  })

  it.each([
    ['a cross-site post', 'meta', { Origin: 'https://evil.example' }, 'cross_site'],
    ['an unknown provider', 'twitter', {}, 'unknown_provider'],
  ])('refuses %s', async (_label, name, headers, reason) => {
    startDbs()
    const response = await start(req(`/oauth/${name}/start`, { method: 'POST', headers }), provider(name))
    expect(location(response).searchParams.get('reason')).toBe(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses the mock provider in production unless opted in', async () => {
    startDbs()
    process.env = { ...process.env, NODE_ENV: 'production' }
    const response = await start(req('/oauth/mock/start', { method: 'POST' }), provider('mock'))
    expect(location(response).searchParams.get('reason')).toBe('unknown_provider')
  })

  it('refuses an invalid LinkedIn author kind', async () => {
    startDbs()
    const response = await start(req('/oauth/linkedin/start', { method: 'POST', body: { authorKind: 'page' } }), provider('linkedin'))
    expect(location(response).searchParams.get('reason')).toBe('invalid_options')
  })

  it('returns to Settings with a short code when the engine is down', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    startDbs()
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const response = await start(req('/oauth/meta/start', { method: 'POST', body: {} }), provider('meta'))
    const url = location(response)
    expect(url.pathname).toBe('/')
    expect(url.searchParams.get('view')).toBe('settings')
    expect(url.searchParams.get('reason')).toBe('engine_unreachable')
  })
})

describe('OAuth callback', () => {
  const ENGINE_ACCOUNTS = {
    accounts: [
      { platform: 'facebook', externalId: 'page-1', displayName: 'AI4L', authorKind: 'page', scopes: [], accessToken: TOKEN },
      { platform: 'instagram', externalId: 'ig-1', displayName: '@ai4l', authorKind: 'instagram_business', scopes: [], accessToken: TOKEN },
    ],
  }

  function callbackDbs(stateRow: unknown) {
    const admin = dbWith({
      social_oauth_states: { data: stateRow, error: null },
      social_accounts: { data: { id: IDS.account }, error: null },
      content_audit_events: { data: null, error: null },
    })
    mockAdmin.mockReturnValue(admin.db)
    return admin
  }

  const run = (query: string, name = 'meta') => callback(req(`/oauth/${name}/callback?${query}`), provider(name))

  it('consumes the state, exchanges the code and stores encrypted tokens', async () => {
    const logs = [jest.spyOn(console, 'error').mockImplementation(() => undefined), jest.spyOn(console, 'log').mockImplementation(() => undefined)]
    const admin = callbackDbs({ brand_id: IDS.brand, options: {} })
    fetchMock.mockResolvedValue(new Response(JSON.stringify(ENGINE_ACCOUNTS), { status: 200 }))

    const response = await run(`code=${CODE}&state=${STATE}`)
    const url = location(response)

    expect(url.searchParams.get('social')).toBe('connected')
    expect(url.searchParams.get('count')).toBe('2')
    const filters = admin.builders.social_oauth_states.allFor('eq').map((call) => call.args)
    expect(filters).toContainEqual(['actor_id', ADMIN_SESSION.userId])
    expect(filters).toContainEqual(['state_hash', hashState(STATE)])
    expect(mockSaveSecrets).toHaveBeenCalledTimes(2)
    expect(mockSaveSecrets.mock.calls[0][1]).toMatchObject({ accessToken: TOKEN })
    expect(JSON.stringify(admin.builders.social_accounts.calls)).not.toContain(TOKEN)
    const everything = [response.headers.get('location'), ...logs.flatMap((spy) => spy.mock.calls.flat().map(String))].join(' ')
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain(CODE)
    expect(everything).not.toContain(STATE)
  })

  it.each([
    ['a replayed (already consumed) state', `code=${CODE}&state=${STATE}`],
    ['an expired state', `code=${CODE}&state=${STATE}`],
    ["another administrator's state", `code=${CODE}&state=${STATE}`],
  ])('refuses %s: the conditional update matches no row', async (_label, query) => {
    callbackDbs(null)
    const response = await run(query)
    expect(location(response).searchParams.get('reason')).toBe('invalid_state')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockSaveSecrets).not.toHaveBeenCalled()
  })

  it('refuses a missing state without touching the table', async () => {
    const admin = callbackDbs({ brand_id: IDS.brand, options: {} })
    const response = await run(`code=${CODE}`)
    expect(location(response).searchParams.get('reason')).toBe('invalid_state')
    expect(admin.builders.social_oauth_states).toBeUndefined()
  })

  it('burns the state when the provider reports a denial', async () => {
    const admin = callbackDbs({ brand_id: IDS.brand, options: {} })
    const response = await run(`error=access_denied&state=${STATE}`)
    expect(location(response).searchParams.get('reason')).toBe('denied')
    expect(admin.builders.social_oauth_states.argsFor('update')).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a missing code', async () => {
    callbackDbs({ brand_id: IDS.brand, options: {} })
    expect(location(await run(`state=${STATE}`)).searchParams.get('reason')).toBe('missing_code')
  })

  it('reports an exchange error with a short code and stores nothing', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    callbackDbs({ brand_id: IDS.brand, options: {} })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: `bad code ${CODE}` }), { status: 400 }))

    const response = await run(`code=${CODE}&state=${STATE}`)

    expect(location(response).searchParams.get('reason')).toBe('engine_refused')
    expect(mockSaveSecrets).not.toHaveBeenCalled()
    expect(errors.mock.calls.flat().map(String).join(' ')).not.toContain(CODE)
  })

  it('reports an exchange that found no usable account', async () => {
    callbackDbs({ brand_id: IDS.brand, options: {} })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accounts: [] }), { status: 200 }))
    expect(location(await run(`code=${CODE}&state=${STATE}`)).searchParams.get('reason')).toBe('no_accounts')
  })

  it('reports a storage failure without detail', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    callbackDbs({ brand_id: IDS.brand, options: {} })
    fetchMock.mockResolvedValue(new Response(JSON.stringify(ENGINE_ACCOUNTS), { status: 200 }))
    mockSaveSecrets.mockRejectedValue(new Error(`encrypt failed ${TOKEN}`))
    const response = await run(`code=${CODE}&state=${STATE}`)
    expect(location(response).searchParams.get('reason')).toBe('connect_failed')
    expect(response.headers.get('location')).not.toContain(TOKEN)
  })

  it('refuses an unknown provider', async () => {
    callbackDbs(null)
    expect(location(await run(`code=${CODE}&state=${STATE}`, 'tiktok')).searchParams.get('reason')).toBe('unknown_provider')
  })
})

describe('publications', () => {
  const BODY = { revisionId: IDS.revision, accountId: IDS.account, idempotencyKey: 'pub-12345678' }

  function publishDbs(overrides: Tables = {}) {
    const member = dbWith(
      {
        social_publications: { data: null, error: null },
        content_variant_revisions: { data: revisionRow(), error: null },
        content_variants: { data: variantRow({ channel: 'linkedin', current_revision_id: IDS.revision }), error: null },
        social_accounts: { data: accountRow(), error: null },
        content_assets: { data: [assetRow()], error: null },
        ...overrides,
      },
      { data: true, error: null }
    )
    mockServerClient.mockResolvedValue(member.db)
    mockAdmin.mockReturnValue({ tag: 'admin' })
    mockLoadTokens.mockResolvedValue({ accessToken: TOKEN, expiresAt: null })
    return member
  }

  it('returns feature_disabled while the studio is off', async () => {
    process.env.CONTENT_STUDIO_ENABLED = 'false'
    const response = await listPublications(req('/publications'))
    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe('feature_disabled')
  })

  it('lists publications, validating itemId', async () => {
    publishDbs({ social_publications: { data: [publicationRow()], error: null } })
    expect((await (await listPublications(req('/publications'))).json()).publications).toHaveLength(1)
    expect((await listPublications(req('/publications?itemId=nope'))).status).toBe(400)
  })

  it('answers the preflight without leaking the token', async () => {
    publishDbs()
    const response = await preflight(req('/publications/preflight', { method: 'POST', body: BODY }))
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(JSON.parse(text).preflight.ok).toBe(true)
    expect(text).not.toContain(TOKEN)
  })

  it('validates the request body', async () => {
    publishDbs()
    expect((await preflight(req('/publications/preflight', { method: 'POST', body: { ...BODY, revisionId: 'x' } }))).status).toBe(400)
    expect((await publish(req('/publications', { method: 'POST', body: { ...BODY, idempotencyKey: 'short' } }))).status).toBe(400)
    expect((await publish(req('/publications', { method: 'POST', body: 'not json' }))).status).toBe(400)
  })

  it('publishes the images and queues the publication (202)', async () => {
    const member = publishDbs()
    mockPublishAsset.mockResolvedValue({ id: IDS.published })
    member.db.rpc.mockImplementation(async (name: string) =>
      name === 'request_social_publication' ? { data: publicationRow(), error: null } : { data: true, error: null }
    )

    const response = await publish(req('/publications', { method: 'POST', body: BODY }))

    expect(response.status).toBe(202)
    expect((await response.json()).publication.id).toBe(IDS.publication)
    expect(member.db.rpc).toHaveBeenCalledWith('request_social_publication', expect.objectContaining({ p_published_asset_ids: [IDS.published] }))
  })

  it('refuses a blocking preflight with 422 preflight_failed', async () => {
    const member = publishDbs()
    member.db.rpc.mockResolvedValue({ data: false, error: null })
    const response = await publish(req('/publications', { method: 'POST', body: BODY }))
    expect(response.status).toBe(422)
    expect((await response.json()).code).toBe('preflight_failed')
    expect(mockPublishAsset).not.toHaveBeenCalled()
  })

  it('maps an RPC conflict to 409 already_published', async () => {
    const member = publishDbs()
    mockPublishAsset.mockResolvedValue({ id: IDS.published })
    member.db.rpc.mockImplementation(async (name: string) =>
      name === 'request_social_publication'
        ? { data: null, error: { message: 'live', code: 'CRM06', hint: 'already_published' } }
        : { data: true, error: null }
    )
    const response = await publish(req('/publications', { method: 'POST', body: BODY }))
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('already_published')
  })
})

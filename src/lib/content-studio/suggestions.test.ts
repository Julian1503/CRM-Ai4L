/** @jest-environment node */
import { createDbMock, createQueryBuilderMock, type QueryBuilderMock } from '@/test/supabaseMock'

import { verifyWorkerRequest } from './workerAuth'
import { ContentHttpError } from './errors'
import { avoidList, getSuggestions, parseEngineResult } from './suggestions'
import { brandRow } from './testFixtures'
import { toBrandProfile } from './mappers'

const SECRET = 's'.repeat(40)
const ENV = { CONTENT_ENGINE_URL: 'https://engine.test/', CONTENT_ENGINE_SECRET: SECRET }
const BRAND = toBrandProfile(brandRow())
const COMPLETION = { title: 'Workshops that fit your week', factIds: ['f1'], channels: ['facebook'] }
const BRIEF_REQUEST = { kind: 'brief_completion' as const, topic: 'Online workshops', draft: { audience: 'Teams' }, fresh: false }

const fetchMock = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  global.fetch = fetchMock as unknown as typeof fetch
})

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

/** A db whose suggestion cache holds `cached` (a stored result) or nothing. */
function dbWith(cached: unknown = null) {
  const builders = new Map<string, QueryBuilderMock>()
  const tables: Record<string, unknown> = {
    content_brand_profiles: { data: brandRow(), error: null },
    content_suggestion_requests: { data: cached === null ? null : { result: cached }, error: null },
  }
  const db = createDbMock((table: string) => {
    if (!builders.has(table)) builders.set(table, createQueryBuilderMock(tables[table] ?? { data: [], error: null }))
    return builders.get(table)
  })
  db.rpc.mockImplementation(async (name: string) => ({ data: name === 'claim_content_suggestion' ? 'request-1' : null, error: null }))
  return { db, cache: () => builders.get('content_suggestion_requests') as QueryBuilderMock }
}

function rpcArgs(db: { rpc: jest.Mock }, name: string) {
  return db.rpc.mock.calls.find((call) => call[0] === name)?.[1]
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string)
}

describe('getSuggestions', () => {
  it('asks the engine with the brand and the context, signed, and records the result', async () => {
    const { db } = dbWith()
    reply(200, { completion: COMPLETION, model: 'gpt-5-mini', promptVersion: 'v1', usage: { promptTokens: 120, bogus: 'x' } })

    const response = await getSuggestions(db as never, BRIEF_REQUEST, ENV)

    expect(response).toEqual({ kind: 'brief_completion', cached: false, completion: COMPLETION })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://engine.test/v1/suggest/brief_completion')
    expect(
      verifyWorkerRequest({
        method: 'POST',
        path: '/v1/suggest/brief_completion',
        rawBody: init.body as string,
        timestampHeader: init.headers['x-content-worker-timestamp'],
        signatureHeader: init.headers['x-content-worker-signature'],
        secret: SECRET,
      })
    ).toEqual({ ok: true })
    expect(sentBody()).toMatchObject({ brand: { slug: 'ai4l' }, topic: 'Online workshops', audience: 'Teams', avoid: [] })
    expect(rpcArgs(db, 'claim_content_suggestion')).toEqual({ p_kind: 'brief_completion', p_context_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(rpcArgs(db, 'finish_content_suggestion')).toMatchObject({
      p_id: 'request-1',
      p_status: 'succeeded',
      p_result: { completion: COMPLETION },
      p_model: 'gpt-5-mini',
      p_usage: { promptTokens: 120 },
      p_error_code: null,
    })
  })

  it('answers from the 24 h cache without taking a slot or calling the engine', async () => {
    const { db, cache } = dbWith({ completion: COMPLETION })

    const response = await getSuggestions(db as never, BRIEF_REQUEST, ENV)

    expect(response).toEqual({ kind: 'brief_completion', cached: true, completion: COMPLETION })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.rpc).not.toHaveBeenCalled()
    expect(cache().argsFor('eq')).toEqual(['kind', 'brief_completion'])
    expect(cache().allFor('eq').map((call) => call.args[0])).toEqual(['kind', 'context_hash', 'status'])
    expect(cache().argsFor('gte')?.[0]).toBe('created_at')
  })

  it('skips the cache when fresh and asks for something different', async () => {
    const { db } = dbWith({ completion: COMPLETION })
    reply(200, { completion: { ...COMPLETION, title: 'Learn together, online' } })

    const response = await getSuggestions(db as never, { ...BRIEF_REQUEST, fresh: true }, ENV)

    expect(response).toMatchObject({ cached: false, completion: { title: 'Learn together, online' } })
    expect(sentBody().avoid).toEqual(['Workshops that fit your week'])
  })

  it('gives the same context the same hash, and a different brief another one', async () => {
    const first = dbWith()
    const second = dbWith()
    const third = dbWith()
    reply(200, { completion: COMPLETION })
    reply(200, { completion: COMPLETION })
    reply(200, { completion: COMPLETION })

    await getSuggestions(first.db as never, BRIEF_REQUEST, ENV)
    await getSuggestions(second.db as never, BRIEF_REQUEST, ENV)
    await getSuggestions(third.db as never, { ...BRIEF_REQUEST, topic: 'Something else' }, ENV)

    const hash = (db: { rpc: jest.Mock }) => rpcArgs(db, 'claim_content_suggestion').p_context_hash
    expect(hash(first.db)).toBe(hash(second.db))
    expect(hash(third.db)).not.toBe(hash(first.db))
  })

  it('refuses before calling the engine when the rate limit is reached', async () => {
    const { db } = dbWith()
    db.rpc.mockResolvedValueOnce({ data: null, error: { code: 'CRM10', message: 'Too many suggestion requests.', hint: 'rate_limited' } })

    await expect(getSuggestions(db as never, BRIEF_REQUEST, ENV)).rejects.toMatchObject({ sqlState: 'CRM10', hint: 'rate_limited' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records an engine failure with its code and answers 503', async () => {
    const { db } = dbWith()
    reply(504, { error: 'The model took too long to answer.', code: 'suggestions_timeout' })

    const failure = await getSuggestions(db as never, BRIEF_REQUEST, ENV).catch((error) => error)

    expect(failure).toBeInstanceOf(ContentHttpError)
    expect(failure).toMatchObject({ status: 503, code: 'suggestions_timeout' })
    expect(rpcArgs(db, 'finish_content_suggestion')).toMatchObject({ p_status: 'failed', p_result: null, p_error_code: 'suggestions_timeout' })
  })

  it('says suggestions are not configured when the engine URL is missing', async () => {
    const { db } = dbWith()

    await expect(getSuggestions(db as never, BRIEF_REQUEST, {})).rejects.toMatchObject({ status: 503, code: 'suggestions_not_configured' })
    // Nothing was claimed, so a missing setting does not use up the member's limit.
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('answers 502 without inviting a retry when the engine refuses the request', async () => {
    const { db } = dbWith()
    reply(422, { error: 'Invalid request body.' })

    await expect(getSuggestions(db as never, BRIEF_REQUEST, ENV)).rejects.toMatchObject({ status: 502, code: 'suggestions_rejected' })
  })

  it('reads a cached row through the same checks as a live answer', async () => {
    const { db } = dbWith({ completion: { title: 'Visit www.evil.example', notes: 'Keep it short', factIds: ['f1', 'x'], channels: ['email'] } })

    const response = await getSuggestions(db as never, BRIEF_REQUEST, ENV)

    expect(response).toEqual({ kind: 'brief_completion', cached: true, completion: { notes: 'Keep it short', factIds: ['f1'], channels: ['email'] } })
  })
})

describe('parseEngineResult', () => {
  it('keeps only approved fact ids and known channels in a completion', () => {
    const result = parseEngineResult(
      'brief_completion',
      { completion: { title: ' A title ', notes: 42, factIds: ['f1', 'nope', 'f1'], channels: ['email', 'tiktok'] } },
      BRAND
    )

    expect(result).toEqual({ completion: { title: 'A title', factIds: ['f1'], channels: ['email'] } })
  })

  it('drops malformed entries and reads at most ten', () => {
    const many = Array.from({ length: 15 }, (_, index) => ({ text: `Idea ${index}` }))

    const rewrites = parseEngineResult('rewrite_instructions', { suggestions: [null, { text: '' }, { text: 7 }, ...many] }, BRAND)

    // Ten entries are read; the two malformed ones among them are dropped.
    expect(rewrites).toEqual({ suggestions: many.slice(0, 8) })
  })

  it('labels an image prompt from its text when the label is missing', () => {
    expect(parseEngineResult('image_prompts', { suggestions: [{ prompt: 'A calm desk at dawn, soft light' }] }, BRAND)).toEqual({
      suggestions: [{ label: 'A calm desk at dawn, soft light', prompt: 'A calm desk at dawn, soft light' }],
    })
  })

  it('needs a title, a topic and a known channel for an idea', () => {
    const result = parseEngineResult(
      'content_ideas',
      {
        suggestions: [
          { title: 'Five tips', topic: 'Tips for teams.', angle: 'Quick wins', channels: ['facebook'] },
          { title: 'No channel', topic: 'x', channels: ['tiktok'] },
          { title: '', topic: 'x', channels: ['email'] },
        ],
      },
      BRAND
    )

    expect(result).toEqual({ suggestions: [{ title: 'Five tips', topic: 'Tips for teams.', angle: 'Quick wins', channels: ['facebook'] }] })
  })

  it('returns null when nothing is left', () => {
    expect(parseEngineResult('content_ideas', { suggestions: 'nope' }, BRAND)).toBeNull()
  })
})

describe('avoidList', () => {
  it('lists the text each kind shows', () => {
    expect(avoidList({ suggestions: [{ text: 'Shorter' }] })).toEqual(['Shorter'])
    expect(avoidList({ suggestions: [{ label: 'Desk', prompt: 'A desk' }] })).toEqual(['A desk'])
    expect(avoidList({ suggestions: [{ title: 'Tips', topic: 't', angle: '', channels: ['email'] }] })).toEqual(['Tips'])
    expect(avoidList({ completion: { factIds: [], channels: [] } })).toEqual([])
    expect(avoidList(null)).toEqual([])
  })
})

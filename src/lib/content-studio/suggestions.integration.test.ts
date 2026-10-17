/**
 * @jest-environment node
 *
 * Suggestions against the local stack, with the engine replaced by a fetch double: a
 * member's request is claimed and settled through the real functions, the stored result
 * is served from the shared cache to another member, and `fresh` asks the engine again
 * with the cached suggestions to avoid.
 *
 * Needs an anon key (SUPABASE_INTEGRATION_ANON_KEY, or NEXT_PUBLIC_SUPABASE_ANON_KEY).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import { integrationEnabled, must, serviceClient, uniqueTag } from '@/test/integration'

import { getSuggestions } from './suggestions'

jest.setTimeout(60_000)

type Db = SupabaseClient<Database>

const url = process.env.SUPABASE_INTEGRATION_URL?.trim() ?? ''
const anonKey = (process.env.SUPABASE_INTEGRATION_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
const describeSuggestions = integrationEnabled && anonKey !== '' ? describe : describe.skip
const ENV = { CONTENT_ENGINE_URL: 'https://engine.test/', CONTENT_ENGINE_SECRET: 's'.repeat(40) }

async function signedInMember(admin: Db): Promise<{ client: Db; userId: string }> {
  const email = `${uniqueTag('suggest')}@example.invalid`
  const password = `Pw-${uniqueTag('it')}-9aZ`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`Could not create a test user: ${error?.message}`)
  await must(admin.from('crm_members').insert({ user_id: data.user.id, role: 'operator', active: true }).select('user_id').single())

  const client = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw new Error(signInError.message)
  return { client, userId: data.user.id }
}

const realFetch = global.fetch

afterAll(() => {
  global.fetch = realFetch
})

/** Answers engine calls in order; everything else (PostgREST, auth) reaches the local stack. */
function engineAnswers(...titles: string[]) {
  const engine = jest.fn()
  for (const title of titles) {
    engine.mockResolvedValueOnce(
      new Response(JSON.stringify({ completion: { title, factIds: [], channels: ['email'] }, model: 'mock', promptVersion: 'v1', usage: { promptTokens: 7 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }
  global.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input).startsWith(ENV.CONTENT_ENGINE_URL) ? engine(input, init) : realFetch(input, init)) as typeof fetch
  return engine
}

describeSuggestions('suggestions against Postgres', () => {
  it('claims, settles, shares the cache and asks again when fresh', async () => {
    const admin = serviceClient()
    const first = await signedInMember(admin)
    const second = await signedInMember(admin)
    const request = { kind: 'brief_completion' as const, topic: `Integration ${uniqueTag('topic')}`, draft: {} }
    const fetchMock = engineAnswers('First title', 'Second title')

    await expect(getSuggestions(first.client, request, ENV)).resolves.toMatchObject({ cached: false, completion: { title: 'First title' } })
    await expect(getSuggestions(second.client, request, ENV)).resolves.toMatchObject({ cached: true, completion: { title: 'First title' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await expect(getSuggestions(second.client, { ...request, fresh: true }, ENV)).resolves.toMatchObject({
      cached: false,
      completion: { title: 'Second title' },
    })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).avoid).toEqual(['First title'])

    const { data: rows } = await admin
      .from('content_suggestion_requests')
      .select('requested_by, status, model, usage, latency_ms')
      .in('requested_by', [first.userId, second.userId])
      .order('created_at', { ascending: true })
    expect(rows).toEqual([
      expect.objectContaining({ requested_by: first.userId, status: 'succeeded', model: 'mock', usage: { promptTokens: 7 } }),
      expect.objectContaining({ requested_by: second.userId, status: 'succeeded' }),
    ])
  })
})

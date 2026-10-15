/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { checkCron, checkDatabase, checkSignupPolicy } from './coreChecks'
import type { HealthDeps } from './deps'
import { checkAi, checkCalendly, checkContentEngine, checkEmailOctopus, checkStripe } from './providerChecks'

const NOW = new Date('2026-10-12T00:00:00Z')

function response(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function stripeReader(overrides: { price?: object; coupon?: object; account?: object | Error } = {}) {
  return {
    prices: {
      retrieve: async (id: string) => ({ id, active: true, livemode: true, currency: 'aud', unit_amount: 50_000, type: 'one_time', ...overrides.price }),
    },
    coupons: { retrieve: async (id: string) => ({ id, valid: true, livemode: true, percent_off: 100, duration: 'once', ...overrides.coupon }) },
    accounts: {
      retrieveCurrent: async () => {
        if (overrides.account instanceof Error) throw overrides.account
        return { charges_enabled: true, ...overrides.account }
      },
    },
  }
}

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: 'sk_live_x',
  STRIPE_CONSULTATION_PRICE_ID: 'price_1',
  STRIPE_CONSULTATION_COUPON_ID: 'coupon_1',
  STRIPE_WEBHOOK_SECRET: 'whsec_1',
}

function deps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    db: createDbMock(createQueryBuilderMock({ data: null, error: null })) as never,
    env: {},
    fetch: jest.fn(async () => response(200)),
    loadEmailOctopusCredentials: async () => null,
    listMergeTags: async () => ({ ok: true, tags: [] }),
    stripe: () => stripeReader(),
    readLastCronRuns: async () => ({ lastRun: null, lastSuccess: null }),
    now: () => NOW,
    ...overrides,
  }
}

describe('database', () => {
  it('is ok when the membership function answers true, down on error, degraded otherwise', async () => {
    const db = (rpc: unknown) => {
      const mock = createDbMock(createQueryBuilderMock())
      mock.rpc.mockResolvedValue(rpc)
      return mock as never
    }
    expect(await checkDatabase(deps({ db: db({ data: true, error: null }) }))).toMatchObject({ state: 'ok' })
    expect(await checkDatabase(deps({ db: db({ data: null, error: { message: 'connection refused at 10.0.0.1' } }) }))).toEqual({
      state: 'down',
      summary: 'The database did not answer the membership check.',
      actionHint: expect.any(String),
    })
    expect(await checkDatabase(deps({ db: db({ data: false, error: null }) }))).toMatchObject({ state: 'degraded' })
  })
})

describe('sign-up policy', () => {
  const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co/', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' }

  it('is ok when sign-up is disabled and degraded when it is open', async () => {
    const fetch = jest.fn(async () => response(200, { disable_signup: true }))
    expect(await checkSignupPolicy(deps({ env, fetch }))).toMatchObject({ state: 'ok' })
    expect(fetch).toHaveBeenCalledWith('https://p.supabase.co/auth/v1/settings', { headers: { apikey: 'anon' } })

    expect(await checkSignupPolicy(deps({ env, fetch: async () => response(200, { disable_signup: false }) }))).toMatchObject({
      state: 'degraded',
      summary: expect.stringMatching(/open/),
    })
  })

  it('reports an unreadable setting and a missing project', async () => {
    expect(await checkSignupPolicy(deps({ env, fetch: async () => response(500) }))).toMatchObject({ state: 'degraded', details: ['Supabase Auth answered HTTP 500.'] })
    expect(await checkSignupPolicy(deps())).toMatchObject({ state: 'not_configured' })
  })
})

describe('cron', () => {
  const run = (hoursAgo: number, status: 'succeeded' | 'failed' = 'succeeded', id = `r-${hoursAgo}`) => ({
    id,
    job: 'jobs' as const,
    status,
    started_at: new Date(NOW.getTime() - hoursAgo * 3_600_000 - 60_000).toISOString(),
    finished_at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    summary: {},
    error_code: null,
  })
  const env = { CRON_SECRET: 's' }

  it("is not configured without its secret: scheduled jobs can't run", async () => {
    expect(await checkCron(deps())).toMatchObject({ state: 'not_configured', summary: expect.stringMatching(/can't run/) })
  })

  it('is ok when the last successful run is recent', async () => {
    const result = await checkCron(deps({ env, readLastCronRuns: async () => ({ lastRun: run(3), lastSuccess: run(3) }) }))
    expect(result).toMatchObject({ state: 'ok', summary: 'Running: last successful run 3 h ago.' })
  })

  it('is degraded when the last success is 26 h or older, saying when', async () => {
    const result = await checkCron(deps({ env, readLastCronRuns: async () => ({ lastRun: run(50), lastSuccess: run(50) }) }))
    expect(result).toMatchObject({ state: 'degraded', summary: 'The last successful scheduled run was 2 days ago.' })
  })

  it('is degraded when the last run failed, naming the last success', async () => {
    const result = await checkCron(deps({ env, readLastCronRuns: async () => ({ lastRun: run(0.2, 'failed'), lastSuccess: run(30) }) }))
    expect(result).toMatchObject({
      state: 'degraded',
      summary: 'The last scheduled run failed, less than an hour ago.',
      details: ['Last run less than an hour ago (failed).', 'Last successful run 30 h ago.'],
    })
  })

  it('is degraded with no recorded run or an unreadable record', async () => {
    expect(await checkCron(deps({ env }))).toMatchObject({ state: 'degraded', summary: 'No scheduled run has been recorded yet.' })
    expect(await checkCron(deps({ env, readLastCronRuns: async () => Promise.reject(new Error('x')) }))).toMatchObject({ state: 'degraded' })
  })
})

describe('EmailOctopus', () => {
  const credentials = { apiKey: 'eo_secret', listId: 'list-1' }

  it('is not configured without saved credentials', async () => {
    expect(await checkEmailOctopus(deps())).toMatchObject({ state: 'not_configured' })
  })

  it('never repeats the provider error, and flags missing fields', async () => {
    const down = await checkEmailOctopus(
      deps({ loadEmailOctopusCredentials: async () => credentials, listMergeTags: async () => ({ ok: false, error: 'Invalid key eo_secret' }) })
    )
    expect(down.state).toBe('down')
    expect(JSON.stringify(down)).not.toContain('eo_secret')

    const missing = await checkEmailOctopus(deps({ loadEmailOctopusCredentials: async () => credentials, listMergeTags: async () => ({ ok: true, tags: ['Headline'] }) }))
    expect(missing).toMatchObject({ state: 'degraded', details: [expect.stringMatching(/Missing fields: Preheader/)] })
  })

  it('is ok with every field, using the time-limited fetch', async () => {
    const listMergeTags = jest.fn(async () => ({
      ok: true as const,
      tags: ['Headline', 'Preheader', 'Intro', 'Benefit1', 'Benefit2', 'Benefit3', 'CtaLabel', 'BookingUrl', 'PrefsUrl', 'Newsletter', 'Courses'],
    }))
    const d = deps({ loadEmailOctopusCredentials: async () => credentials, listMergeTags })
    expect(await checkEmailOctopus(d)).toMatchObject({ state: 'ok' })
    expect(listMergeTags).toHaveBeenCalledWith({ ...credentials, fetchImpl: d.fetch })
  })
})

describe('Stripe', () => {
  it('names the missing settings without values', async () => {
    const result = await checkStripe(deps({ env: { STRIPE_SECRET_KEY: 'sk_live_secret' } }))
    expect(result).toMatchObject({ state: 'not_configured', details: ['Missing: STRIPE_CONSULTATION_PRICE_ID, STRIPE_CONSULTATION_COUPON_ID, STRIPE_WEBHOOK_SECRET.'] })
    expect(JSON.stringify(result)).not.toContain('sk_live_secret')
  })

  it('is ok in live mode with a ready price, coupon and account', async () => {
    expect(await checkStripe(deps({ env: STRIPE_ENV }))).toMatchObject({ state: 'ok', details: ['Key mode: live.'] })
  })

  it('is degraded in test mode or when the account cannot be read', async () => {
    const test = await checkStripe(deps({ env: { ...STRIPE_ENV, STRIPE_SECRET_KEY: 'sk_test_x' }, stripe: () => stripeReader({ price: { livemode: false }, coupon: { livemode: false } }) }))
    expect(test).toMatchObject({ state: 'degraded', summary: expect.stringMatching(/test mode/) })

    const unreadable = await checkStripe(deps({ env: STRIPE_ENV, stripe: () => stripeReader({ account: new Error('boom') }) }))
    expect(unreadable).toMatchObject({ state: 'degraded', details: expect.arrayContaining(['The account status could not be read.']) })
  })

  it('is down when checkout cannot start, without Stripe\'s own error text', async () => {
    const stripe = () => ({
      ...stripeReader({ account: { charges_enabled: false } }),
      prices: { retrieve: async () => Promise.reject(Object.assign(new Error("No such price: 'price_1'; request req_secret"), { type: 'invalid_request_error' })) },
    })
    const result = await checkStripe(deps({ env: STRIPE_ENV, stripe }))

    expect(result.state).toBe('down')
    expect(result.details).toEqual(
      expect.arrayContaining([
        'STRIPE_CONSULTATION_PRICE_ID (price_1) could not be read with this key.',
        'The Stripe account cannot take charges yet.',
      ])
    )
    expect(JSON.stringify(result)).not.toContain('req_secret')
  })
})

describe('Calendly', () => {
  const env = { CALENDLY_SCHEDULING_URL: 'https://calendly.com/ai4l/consult', CALENDLY_WEBHOOK_SECRET: 'w' }
  const ledger = (row: unknown, error: unknown = null) => createDbMock(createQueryBuilderMock({ data: row, error })) as never

  it('is ok with a reachable page and a recent webhook', async () => {
    const result = await checkCalendly(deps({ env, db: ledger({ received_at: '2026-10-10T00:00:00Z' }) }))
    expect(result).toMatchObject({ state: 'ok', details: ['Last webhook received 2026-10-10T00:00:00Z.'] })
  })

  it('is degraded when no webhook ever arrived, or none recently', async () => {
    expect(await checkCalendly(deps({ env, db: ledger(null) }))).toMatchObject({ state: 'degraded', details: ['No Calendly webhook has ever been received.'] })
    expect(await checkCalendly(deps({ env, db: ledger({ received_at: '2026-08-01T00:00:00Z' }) }))).toMatchObject({ state: 'degraded', summary: expect.stringMatching(/30 days/) })
  })

  it('is down when the page fails, and reports an unreadable ledger', async () => {
    expect(await checkCalendly(deps({ env, db: ledger(null), fetch: async () => response(404) }))).toMatchObject({ state: 'down', details: expect.arrayContaining(['The scheduling page answered HTTP 404.']) })
    expect(
      await checkCalendly(deps({ env, db: ledger(null, { message: 'x' }), fetch: async () => Promise.reject(new Error('dns')) }))
    ).toMatchObject({ state: 'down', details: ['The scheduling page did not answer.', 'The webhook ledger could not be read.'] })
  })

  it('is not configured without its settings', async () => {
    expect(await checkCalendly(deps())).toMatchObject({ state: 'not_configured' })
  })
})

describe('AI copy and the content engine', () => {
  it('checks the key with a free model listing, never a generation', async () => {
    const fetch = jest.fn(async () => response(200))
    expect(await checkAi(deps({ env: { ANTHROPIC_API_KEY: 'sk-ant' }, fetch }))).toMatchObject({ state: 'ok' })
    expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/models?limit=1', expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'sk-ant' }) }))

    expect(await checkAi(deps({ env: { ANTHROPIC_API_KEY: 'k' }, fetch: async () => response(401) }))).toMatchObject({ state: 'down' })
    expect(await checkAi(deps({ env: { ANTHROPIC_API_KEY: 'k' }, fetch: async () => response(529) }))).toMatchObject({ state: 'degraded' })
    expect(await checkAi(deps({ env: { ANTHROPIC_API_KEY: 'k' }, fetch: async () => Promise.reject(new Error('x')) }))).toMatchObject({ state: 'degraded' })
    expect(await checkAi(deps())).toMatchObject({ state: 'not_configured' })
  })

  it('reads the engine health endpoint', async () => {
    const fetch = jest.fn(async () => response(200))
    expect(await checkContentEngine(deps({ env: { CONTENT_ENGINE_URL: 'https://engine/' }, fetch }))).toMatchObject({ state: 'ok' })
    expect(fetch).toHaveBeenCalledWith('https://engine/health')
    expect(await checkContentEngine(deps({ env: { CONTENT_ENGINE_URL: 'https://engine' }, fetch: async () => response(503) }))).toMatchObject({ state: 'down' })
    expect(await checkContentEngine(deps({ env: { CONTENT_ENGINE_URL: 'https://engine' }, fetch: async () => Promise.reject(new Error('x')) }))).toMatchObject({ state: 'down' })
    expect(await checkContentEngine(deps())).toMatchObject({ state: 'not_configured' })
  })
})

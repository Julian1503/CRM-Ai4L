/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import type { HealthDeps } from './deps'
import { HEALTH_CHECKS, runAllHealthChecks, runHealthCheck, timedFetch } from './runner'
import { HEALTH_CHECK_IDS, isHealthCheckId } from './types'

const NOW = new Date('2026-10-12T00:00:00Z')

function deps(): HealthDeps {
  const db = createDbMock(createQueryBuilderMock({ data: null, error: null }))
  db.rpc.mockResolvedValue({ data: true, error: null })
  return {
    db: db as never,
    env: {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ disable_signup: true }) }) as Response,
    loadEmailOctopusCredentials: async () => null,
    listMergeTags: async () => ({ ok: true, tags: [] }),
    stripe: () => {
      throw new Error('not used')
    },
    readLastCronRuns: async () => ({ lastRun: null, lastSuccess: null }),
    now: () => NOW,
  }
}

describe('health runner', () => {
  afterEach(() => jest.restoreAllMocks())

  it('runs every check once, labelled and timed', async () => {
    const results = await runAllHealthChecks(deps())

    expect(results.map((result) => result.id)).toEqual([...HEALTH_CHECK_IDS])
    expect(results.every((result) => result.checkedAt === NOW.toISOString() && result.label)).toBe(true)
    expect(results.find((result) => result.id === 'database')).toMatchObject({ label: 'Database', state: 'ok' })
  })

  it('reports a throwing check as down with a fixed message, never the error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(HEALTH_CHECKS, 'ai').mockRejectedValueOnce(new Error('secret sk-ant-123 in a stack'))

    const result = await runHealthCheck('ai', deps())

    expect(result).toMatchObject({ id: 'ai', state: 'down', summary: 'The check could not be completed.' })
    expect(JSON.stringify(result)).not.toContain('sk-ant')
  })

  it('gives up on a check that does not finish in time', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(HEALTH_CHECKS, 'content_engine').mockReturnValueOnce(new Promise(() => {}))

    const result = await runHealthCheck('content_engine', deps(), 10)

    expect(result).toMatchObject({ state: 'down', summary: 'The check did not finish in time.' })
  })

  it('makes requests uncached and time-limited', async () => {
    const base = jest.fn(async () => ({ ok: true }) as Response)
    await timedFetch(1000, base as never)('https://x', { method: 'GET' })

    expect(base).toHaveBeenCalledWith('https://x', expect.objectContaining({ method: 'GET', cache: 'no-store', signal: expect.any(AbortSignal) }))
  })

  it('recognises check ids', () => {
    expect(isHealthCheckId('stripe')).toBe(true)
    expect(isHealthCheckId('../etc')).toBe(false)
  })
})

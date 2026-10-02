/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { readAttentionCounts } from './attention'

describe('readAttentionCounts', () => {
  it('counts each kind of stuck work with head-only queries', async () => {
    const sends = createQueryBuilderMock([
      { data: null, error: null, count: 2 },
      { data: null, error: null, count: 1 },
    ])
    const outbox = createQueryBuilderMock([
      { data: null, error: null, count: 5 },
      { data: null, error: null, count: 0 },
    ])
    const jobs = createQueryBuilderMock([
      { data: null, error: null, count: 3 },
      { data: null, error: null, count: 4 },
      { data: null, error: null, count: 6 },
    ])
    const accounts = createQueryBuilderMock({ data: null, error: null, count: 7 })
    const publications = createQueryBuilderMock({ data: null, error: null, count: 8 })
    const byTable: Record<string, unknown> = {
      campaign_sends: sends,
      consent_sync_outbox: outbox,
      content_jobs: jobs,
      social_accounts: accounts,
      social_publications: publications,
    }
    const db = createDbMock((table: string) => byTable[table])

    await expect(readAttentionCounts(db as never, Date.parse('2026-10-08T00:00:00Z'))).resolves.toEqual({
      uncertainSends: 2,
      expiredSendClaims: 1,
      consentSyncPending: 5,
      consentSyncFailed: 0,
      contentJobsStale: 3,
      contentJobsFailed: 4,
      contentJobsUncertain: 6,
      socialAccountsUnhealthy: 7,
      socialPublicationsUncertain: 8,
    })
    expect(sends.argsFor('select')).toEqual(['id', { count: 'exact', head: true }])
    expect(jobs.allFor('eq').map((call) => call.args)).toEqual([
      ['status', 'running'],
      ['status', 'failed'],
      ['status', 'uncertain'],
    ])
    expect(jobs.argsFor('lt')).toEqual(['lease_expires_at', '2026-10-08T00:00:00.000Z'])
    expect(jobs.argsFor('gte')).toEqual(['finished_at', '2026-10-01T00:00:00.000Z'])
    expect(accounts.argsFor('eq')).toEqual(['status', 'needs_reauth'])
    expect(publications.argsFor('eq')).toEqual(['status', 'uncertain'])
  })

  it('uses the current time by default', async () => {
    const zero = createQueryBuilderMock({ data: null, error: null, count: null })
    await expect(readAttentionCounts(createDbMock(zero) as never)).resolves.toMatchObject({ contentJobsStale: 0 })
  })

  it('surfaces a failed count rather than reporting zero', async () => {
    const failing = createQueryBuilderMock({ data: null, error: { message: 'denied' }, count: null })
    await expect(readAttentionCounts(createDbMock(failing) as never)).rejects.toThrow('denied')
  })
})

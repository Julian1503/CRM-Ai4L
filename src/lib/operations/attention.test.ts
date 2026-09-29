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
    const db = createDbMock((table: string) => (table === 'campaign_sends' ? sends : outbox))

    await expect(readAttentionCounts(db as never)).resolves.toEqual({
      uncertainSends: 2,
      expiredSendClaims: 1,
      consentSyncPending: 5,
      consentSyncFailed: 0,
    })
    expect(sends.argsFor('select')).toEqual(['id', { count: 'exact', head: true }])
  })

  it('surfaces a failed count rather than reporting zero', async () => {
    const failing = createQueryBuilderMock({ data: null, error: { message: 'denied' }, count: null })
    await expect(readAttentionCounts(createDbMock(failing) as never)).rejects.toThrow('denied')
  })
})

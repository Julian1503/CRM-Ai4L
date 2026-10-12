/** @jest-environment node */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { customerShare, fetchContactStats } from './stats'

function db(responses: unknown[]) {
  const builder = createQueryBuilderMock(responses)
  return { db: createDbMock(builder), builder }
}

const ok = (count: number) => ({ data: null, error: null, count })

describe('fetchContactStats', () => {
  it('counts every status separately instead of deriving prospects', async () => {
    const { db: mock, builder } = db([ok(10), ok(4), ok(3), ok(2), ok(6), ok(5)])

    await expect(fetchContactStats(mock as never)).resolves.toEqual({
      total: 10,
      leads: 4,
      prospects: 3,
      customers: 2,
      newsletter: 6,
      programs: 5,
    })
    expect(mock.from).toHaveBeenCalledWith('active_contacts')
    expect(builder.allFor('eq').map((call) => call.args)).toEqual([
      ['status', 'lead'],
      ['status', 'prospect'],
      ['status', 'customer'],
      ['subscribed_to_newsletter', true],
      ['subscribed_to_programs', true],
    ])
    expect(builder.argsFor('select')).toEqual(['id', { count: 'exact', head: true }])
  })

  it('rejects when any count fails, rather than reporting zero (audit M2)', async () => {
    const { db: mock } = db([ok(10), { data: null, error: { message: 'timeout' }, count: null }, ok(1), ok(1), ok(1), ok(1)])

    await expect(fetchContactStats(mock as never)).rejects.toThrow('Could not count leads: timeout')
  })

  it('rejects when a count is missing', async () => {
    const { db: mock } = db([{ data: null, error: null, count: null }])

    await expect(fetchContactStats(mock as never)).rejects.toThrow('Could not count contacts: no count returned.')
  })
})

describe('customerShare', () => {
  it('is customers over total, rounded, and 0 for an empty database', () => {
    expect(customerShare({ total: 3, customers: 1 })).toBe(33)
    expect(customerShare({ total: 0, customers: 0 })).toBe(0)
  })
})

/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { readLastCronRuns, recordCronRun } from './cronRuns'

const STARTED = new Date('2026-10-12T00:00:00Z')

describe('recordCronRun', () => {
  afterEach(() => jest.restoreAllMocks())

  it('writes one row with counts only', async () => {
    const builder = createQueryBuilderMock({ data: null, error: null })

    await recordCronRun(createDbMock(builder) as never, {
      job: 'jobs',
      status: 'succeeded',
      startedAt: STARTED,
      summary: { campaigns: 2, stoppedForBudget: false, email: 'someone@example.com' as never, bad: Number.NaN },
    })

    expect(builder.argsFor('insert')).toEqual([
      { job: 'jobs', status: 'succeeded', started_at: STARTED.toISOString(), summary: { campaigns: 2, stoppedForBudget: false }, error_code: null },
    ])
  })

  it('logs and swallows a failed write, or a thrown one', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      recordCronRun(createDbMock(createQueryBuilderMock({ data: null, error: { code: '42501', message: 'denied' } })) as never, {
        job: 'newsletters',
        status: 'failed',
        startedAt: STARTED,
        errorCode: 'run_failed',
      })
    ).resolves.toBeUndefined()
    const throwing = { from: () => { throw new Error('no client') } }
    await expect(recordCronRun(throwing as never, { job: 'jobs', status: 'succeeded', startedAt: STARTED })).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledTimes(2)
  })
})

describe('readLastCronRuns', () => {
  it('reads the latest run and the latest success of a job', async () => {
    const row = { id: 'r1', job: 'jobs', status: 'succeeded', finished_at: '2026-10-12T00:00:00Z' }
    const builder = createQueryBuilderMock({ data: row, error: null })

    expect(await readLastCronRuns(createDbMock(builder) as never, 'jobs')).toEqual({ lastRun: row, lastSuccess: row })
    expect(builder.allFor('eq').map((call) => call.args)).toEqual([['job', 'jobs'], ['job', 'jobs'], ['status', 'succeeded']])
  })

  it('throws when the record cannot be read', async () => {
    const builder = createQueryBuilderMock({ data: null, error: { message: 'down' } })
    await expect(readLastCronRuns(createDbMock(builder) as never, 'jobs')).rejects.toThrow('cron_runs unreadable')
  })
})

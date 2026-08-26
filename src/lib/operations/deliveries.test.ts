/**
 * @jest-environment node
 */
import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { completeIntegrationDelivery, startIntegrationDelivery } from './deliveries'

function asDb(db: ReturnType<typeof createDbMock>): SupabaseClient<Database> {
  return db as unknown as SupabaseClient<Database>
}

describe('integration delivery traces', () => {
  it('starts a trace without storing a provider payload', async () => {
    const deliveries = createQueryBuilderMock({ data: { id: 'delivery-1' }, error: null })
    const db = createDbMock(deliveries)

    await expect(startIntegrationDelivery(asDb(db), 'emailoctopus', 'batch')).resolves.toBe(
      'delivery-1'
    )

    const inserted = deliveries.argsFor('insert')?.[0] as Record<string, unknown>
    expect(inserted).toEqual({
      provider: 'emailoctopus',
      event_type: 'batch',
      status: 'processing',
    })
    expect(Object.keys(inserted)).not.toEqual(
      expect.arrayContaining(['payload', 'raw_body', 'email', 'secret'])
    )
  })

  it('writes bounded counts and a controlled error code on completion', async () => {
    const deliveries = createQueryBuilderMock({ data: null, error: null })
    const db = createDbMock(deliveries)

    await completeIntegrationDelivery(asDb(db), 'delivery-1', {
      status: 'failed',
      eventCount: 2,
      processedCount: 1,
      failedCount: 99,
      errorCode: 'processing_failed',
    })

    expect(deliveries.argsFor('update')).toEqual([
      expect.objectContaining({
        status: 'failed',
        event_count: 2,
        processed_count: 1,
        failed_count: 1,
        error_code: 'processing_failed',
        completed_at: expect.any(String),
      }),
    ])
    expect(deliveries.allFor('eq')[0]?.args).toEqual(['id', 'delivery-1'])
  })

  it('does nothing when the start trace was unavailable', async () => {
    const deliveries = createQueryBuilderMock()
    const db = createDbMock(deliveries)

    await completeIntegrationDelivery(asDb(db), null, {
      status: 'succeeded',
      eventCount: 1,
      processedCount: 1,
      failedCount: 0,
    })

    expect(db.from).not.toHaveBeenCalled()
  })

  it('does not fail webhook processing when telemetry storage fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const deliveries = createQueryBuilderMock({ data: null, error: { message: 'missing table' } })
    const db = createDbMock(deliveries)

    await expect(startIntegrationDelivery(asDb(db), 'stripe')).resolves.toBeNull()
    expect(consoleError).toHaveBeenCalled()

    consoleError.mockRestore()
  })
})

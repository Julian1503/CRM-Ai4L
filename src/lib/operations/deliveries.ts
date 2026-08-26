import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database, IntegrationDeliveryStatus } from '@/lib/db/types'
import type { IntegrationProvider } from '@/lib/operations/types'

export type IntegrationDeliveryErrorCode =
  | 'malformed_json'
  | 'invalid_payload'
  | 'processing_failed'

type Completion = {
  status: Exclude<IntegrationDeliveryStatus, 'processing'>
  eventCount: number
  processedCount: number
  failedCount: number
  errorCode?: IntegrationDeliveryErrorCode
}

function count(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
}

/**
 * Starts a privacy-minimised delivery trace. Observability is best-effort: a telemetry
 * outage must never prevent a verified provider event from reaching its business path.
 */
export async function startIntegrationDelivery(
  db: SupabaseClient<Database>,
  provider: IntegrationProvider,
  eventType: string | null = null
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from('integration_deliveries')
      .insert({ provider, event_type: eventType, status: 'processing' })
      .select('id')
      .single()

    if (error || !data?.id) {
      console.error(`Could not start ${provider} delivery trace: ${error?.message ?? 'no id'}`)
      return null
    }

    return data.id
  } catch (error) {
    console.error(`Could not start ${provider} delivery trace:`, error)
    return null
  }
}

/** Completes a trace without ever accepting raw provider errors or payload content. */
export async function completeIntegrationDelivery(
  db: SupabaseClient<Database>,
  deliveryId: string | null,
  completion: Completion
): Promise<void> {
  if (!deliveryId) return

  const eventCount = count(completion.eventCount)
  const processedCount = Math.min(count(completion.processedCount), eventCount)
  const failedCount = Math.min(count(completion.failedCount), eventCount - processedCount)

  try {
    const { error } = await db
      .from('integration_deliveries')
      .update({
        status: completion.status,
        event_count: eventCount,
        processed_count: processedCount,
        failed_count: failedCount,
        error_code: completion.errorCode ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', deliveryId)

    if (error) {
      console.error(`Could not complete integration delivery trace: ${error.message}`)
    }
  } catch (error) {
    console.error('Could not complete integration delivery trace:', error)
  }
}

export type IntegrationProvider = 'emailoctopus' | 'stripe' | 'calendly'

export type IntegrationDeliveryStatus =
  | 'processing'
  | 'succeeded'
  | 'completed_with_errors'
  | 'failed'

export type IntegrationHealth = {
  provider: IntegrationProvider
  deliveries24h: number
  failed24h: number
  processing: number
  processingStale: number
  events24h: number
  failedEvents24h: number
  lastDeliveryAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
}

export type OperationsSummary = {
  generatedAt: string
  integrations: IntegrationHealth[]
  campaignSends: {
    pending: number
    sent: number
    failed: number
    skipped: number
  }
  bookings: {
    pending: number
    checkoutStarted: number
    paid: number
    booked: number
    cancelled: number
    expired: number
  }
  sync: {
    events24h: number
    failures24h: number
    latestAt: string | null
  }
  /** Stuck work needing a person. Added by the API route; see src/lib/operations/attention.ts. */
  attention?: import('./attention').AttentionCounts
}

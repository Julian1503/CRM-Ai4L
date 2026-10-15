import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import type { EmailOctopusCredentials } from '@/lib/marketing/providers/credentials'
import type { StripeResourceReader } from '@/lib/stripe/health'

import type { CronJob } from '@/lib/db/cronRunTypes'

import type { LastCronRuns } from './cronRuns'
import type { HealthResult, HealthState } from './types'

/** What a check reports; the runner adds id, label and time. */
export type CheckOutcome = {
  state: HealthState
  summary: string
  details?: string[]
  actionHint?: string
}

export type Env = Record<string, string | undefined>

/** The Stripe calls a health check makes: read-only. */
export type StripeHealthReader = StripeResourceReader & {
  accounts: { retrieveCurrent: () => Promise<{ charges_enabled: boolean }> }
}

/**
 * Everything a check reaches outside itself, injected so every check is testable with
 * no network, no database and no SDK.
 */
export type HealthDeps = {
  /** The member's own client: reads go through RLS. */
  db: SupabaseClient<Database>
  env: Env
  /** A fetch that gives up after `timeoutMs`. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  loadEmailOctopusCredentials: () => Promise<EmailOctopusCredentials | null>
  listMergeTags: (config: EmailOctopusCredentials & { fetchImpl?: (url: string, init?: RequestInit) => Promise<Response> }) => Promise<
    { ok: true; tags: string[] } | { ok: false; error: string }
  >
  stripe: (secretKey: string) => StripeHealthReader
  readLastCronRuns: (job: CronJob) => Promise<LastCronRuns>
  now: () => Date
}

export type HealthCheck = (deps: HealthDeps) => Promise<CheckOutcome>

export type { HealthResult }

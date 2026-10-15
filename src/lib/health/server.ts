import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import { loadEmailOctopusCredentials } from '@/lib/marketing/providers/credentials'
import { listMergeTags } from '@/lib/marketing/providers/emailOctopus'
import { getStripeClient } from '@/lib/stripe/client'

import { readLastCronRuns } from './cronRuns'
import type { HealthDeps } from './deps'
import { REQUEST_TIMEOUT_MS, timedFetch } from './runner'

/**
 * The production wiring for the health checks. Credentials are read server-side (the
 * EmailOctopus key through the service-role loader); nothing read here is returned.
 */
export function healthDeps(db: SupabaseClient<Database>): HealthDeps {
  return {
    db,
    env: process.env,
    fetch: timedFetch(REQUEST_TIMEOUT_MS),
    loadEmailOctopusCredentials: () => loadEmailOctopusCredentials(),
    listMergeTags: (config) => listMergeTags({ ...config, fetchImpl: config.fetchImpl as typeof fetch | undefined }),
    stripe: (secretKey) => {
      const client = getStripeClient(secretKey)
      const options = { timeout: REQUEST_TIMEOUT_MS, maxNetworkRetries: 0 }
      return {
        prices: { retrieve: (id: string) => client.prices.retrieve(id, {}, options) },
        coupons: { retrieve: (id: string) => client.coupons.retrieve(id, {}, options) },
        accounts: { retrieveCurrent: () => client.accounts.retrieveCurrent({}, options) },
      }
    },
    readLastCronRuns: (job) => readLastCronRuns(db, job),
    now: () => new Date(),
  }
}

/**
 * Harness for the *.integration.test.ts suites (audit T2).
 *
 * They run against the local Supabase stack only — never a hosted project — and are
 * skipped unless SUPABASE_INTEGRATION_URL and SUPABASE_INTEGRATION_SERVICE_KEY are set:
 *
 *   npm run test:integration      (CI's integration job sets both from `supabase status`)
 *
 * Every fixture is created with a unique tag, and nothing is physically deleted.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

const url = process.env.SUPABASE_INTEGRATION_URL?.trim() ?? ''
const serviceKey = process.env.SUPABASE_INTEGRATION_SERVICE_KEY?.trim() ?? ''

function isLocal(value: string): boolean {
  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(value).hostname)
  } catch {
    return false
  }
}

export const integrationEnabled = Boolean(url && serviceKey && isLocal(url))

/** `describe` when a local stack is configured, `describe.skip` otherwise. */
export const describeIntegration = integrationEnabled ? describe : describe.skip

export function serviceClient(): SupabaseClient<Database> {
  if (!integrationEnabled) throw new Error('Integration tests need a local Supabase stack.')
  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

export function uniqueTag(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

type RpcFault = (fn: string, args: Record<string, unknown>, call: number) => { message: string } | null

/**
 * Wraps a client so chosen RPC calls fail — a database fault injected at an exact
 * persistence boundary rather than simulated with sleeps.
 */
export function withRpcFaults(db: SupabaseClient<Database>, fault: RpcFault): SupabaseClient<Database> {
  const counts = new Map<string, number>()

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'rpc') return Reflect.get(target, property, receiver)

      return (fn: string, args: Record<string, unknown>, options?: unknown) => {
        const call = (counts.get(fn) ?? 0) + 1
        counts.set(fn, call)
        const injected = fault(fn, args, call)
        if (injected) return Promise.resolve({ data: null, error: injected, count: null, status: 500 })
        return (target.rpc as unknown as (...a: unknown[]) => unknown).call(target, fn, args, options)
      }
    },
  })
}

/** Unwraps a PostgREST result, failing the test on an error or a missing row. */
export async function must<T>(
  promise: PromiseLike<{ data: T; error: { message: string } | null }>
): Promise<NonNullable<T>> {
  const { data, error } = await promise
  if (error) throw new Error(error.message)
  if (data === null || data === undefined) throw new Error('Expected a result, got none.')
  return data as NonNullable<T>
}

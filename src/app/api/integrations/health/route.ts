import type { NextResponse } from 'next/server'

import { ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { runAllHealthChecks } from '@/lib/health/runner'
import { healthDeps } from '@/lib/health/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * GET /api/integrations/health -> { checks: HealthResult[] }
 *
 * Every integration's state for the Settings cards (UX plan P1.5). Members only; every
 * check is read-only, time-limited, and returns no secret or provider error body.
 */
export async function GET(): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  try {
    const db = await createSupabaseServerClient()
    return ok({ checks: await runAllHealthChecks(healthDeps(db)) })
  } catch (error) {
    console.error('Integration health failed:', error instanceof Error ? error.name : 'unknown error')
    return serverError(null, 'Could not check the integrations.')
  }
}

import type { NextRequest, NextResponse } from 'next/server'

import { forbidden, notFound, ok, requireSessionOr401, serverError } from '@/lib/api/responses'
import { runHealthCheck } from '@/lib/health/runner'
import { healthDeps } from '@/lib/health/server'
import { isHealthCheckId } from '@/lib/health/types'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/integrations/health/[id]/test -> { check: HealthResult }
 *
 * Re-runs one check now ("Test connection"). Administrators only: it reaches external
 * providers on demand. Read-only like every check.
 */
export async function POST(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response
  if (guard.session.role !== 'admin') return forbidden('Only an administrator can test a connection.')

  const { id } = await params
  if (!isHealthCheckId(id)) return notFound('Unknown integration.')

  try {
    const db = await createSupabaseServerClient()
    return ok({ check: await runHealthCheck(id, healthDeps(db)) })
  } catch (error) {
    console.error('Integration test failed:', error instanceof Error ? error.name : 'unknown error')
    return serverError(null, 'Could not test the connection.')
  }
}

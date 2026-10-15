import type { NextRequest, NextResponse } from 'next/server'

import { ok, serverError, unauthorized } from '@/lib/api/responses'
import { isAuthorisedCronRequest } from '@/lib/auth/cron'
import { preferencesOrigin } from '@/lib/contacts/providerSync'
import { runJobs } from '@/lib/jobs/runJobs'
import { loadEmailOctopusCredentials } from '@/lib/marketing/providers/credentials'
import { getStripeClient, getStripeConfig } from '@/lib/stripe/client'
import { recordCronRun } from '@/lib/health/cronRuns'
import { getAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 300

/** Leaves headroom under maxDuration for the final summary and the response. */
const BUDGET_MS = 240_000

/**
 * Durable background work: the consent outbox and campaigns left mid-send. See
 * src/lib/jobs/runJobs.ts. Authenticated by CRON_SECRET (src/lib/auth/cron.ts).
 *
 * vercel.json schedules it daily, the Hobby plan's limit. On a plan that allows it, run
 * it every few minutes (docs/DEPLOYMENT.md): every job is idempotent and resumable.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorisedCronRequest(request.headers.get('authorization'))) {
    return unauthorized()
  }

  // Each run is recorded for the integration health card; recording never fails the run.
  const startedAt = new Date()
  let db: ReturnType<typeof getAdminClient> | null = null

  try {
    db = getAdminClient()
    const stripeConfig = getStripeConfig()
    const stripe = stripeConfig ? getStripeClient(stripeConfig.secretKey) : null
    const report = await runJobs({
      db,
      credentials: await loadEmailOctopusCredentials(db),
      baseUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() || null,
      preferencesOrigin: preferencesOrigin(null),
      retrieveCheckout: stripe ? (id) => stripe.checkout.sessions.retrieve(id) : null,
      budgetMs: BUDGET_MS,
    })

    await recordCronRun(db, {
      job: 'jobs',
      status: 'succeeded',
      startedAt,
      summary: {
        consentSynced: report.consent.synced,
        consentFailed: report.consent.failed,
        notificationsSent: report.notifications.sent,
        reconciliationResolved: report.reconciliation.resolved,
        campaigns: report.campaigns.length,
        stoppedForBudget: report.stoppedForBudget,
      },
    })

    return ok(report)
  } catch (error) {
    console.error('Scheduled jobs failed:', error)
    if (db) await recordCronRun(db, { job: 'jobs', status: 'failed', startedAt, errorCode: 'run_failed' })
    return serverError(null, 'The scheduled jobs failed. See the server log.')
  }
}

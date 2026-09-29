import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import {
  badRequest,
  conflict,
  notFound,
  ok,
  requireSessionOr401,
  serverError,
} from '@/lib/api/responses'
import { advanceCampaignSend } from '@/lib/marketing/dispatch'
import { loadEmailOctopusCredentials } from '@/lib/marketing/providers/credentials'
import { LedgerWriteError } from '@/lib/marketing/send'
import { readCampaignSendSummary } from '@/lib/marketing/sendStatus'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** How many recipients one invocation handles before returning. */
const CHUNK_SIZE = 200

/**
 * Sends one chunk of an approved campaign.
 *
 * Chunked because EmailOctopus has no broadcast send: one API call per recipient
 * against a 100-token bucket refilling at 10/sec. The caller repeats this endpoint
 * while `hasMore`; the scheduled worker (/api/cron/jobs) also resumes any campaign left
 * in `sending`, so a closed browser tab no longer stalls a send. Both are safe at once:
 * recipients are claimed atomically. See src/lib/marketing/dispatch.ts.
 */
export async function POST(
  request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  if (!id) return badRequest('Campaign id is required.')

  try {
    // Provider credentials live server-side; they are never accepted from the client.
    const credentials = await loadEmailOctopusCredentials()
    if (!credentials) return conflict('EmailOctopus credentials are not configured in Settings.')

    const db = await createSupabaseServerClient()
    // Booking links must point at the deployed host, not whatever origin served this
    // request; the request origin is a local-development fallback.
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || request.nextUrl.origin

    const outcome = await advanceCampaignSend(db, id, { credentials, baseUrl, chunkSize: CHUNK_SIZE })

    if (outcome.kind === 'not_found') return notFound('Campaign not found.')
    if (outcome.kind === 'conflict') return conflict(outcome.message)

    const { progress, summary } = outcome

    return ok({
      status: outcome.status,
      processed: progress.total,
      sent: summary.sent,
      failed: summary.failed,
      pending: summary.pending,
      skipped: summary.skipped,
      uncertain: summary.uncertain,
      /** True while the caller should keep invoking this endpoint. */
      hasMore: summary.pending > 0,
      /** Which fan-out these figures belong to. 1 unless the campaign was re-sent. */
      run: summary.run,
      /**
       * What this invocation achieved, separate from the cumulative totals: a chunk that
       * claimed recipients and neither sent nor failed any of them is stalled, and
       * looping on it forever is how a rate-limited send used to look like progress.
       */
      chunk: {
        processed: progress.total,
        sent: progress.sent,
        failed: progress.failed,
        skipped: progress.skipped,
        uncertain: progress.uncertain,
        deferred: progress.remaining,
        reason: progress.deferredReason ?? null,
      },
      /** Why recipients failed, in the provider's own words. Null when none did. */
      failureReason: summary.failureReason ?? progress.failureReason ?? null,
    })
  } catch (error) {
    if (error instanceof LedgerWriteError) {
      // Stop the caller's loop: sending more while outcomes cannot be recorded is how
      // duplicates happen. Affected recipients surface as uncertain after their lease.
      console.error('Campaign send halted on a ledger write failure:', error)
      return serverError(error)
    }
    return serverError(error, 'Could not send campaign.')
  }
}

/**
 * Reports what happened to a campaign's recipients, so a failure survives the click
 * that caused it.
 */
export async function GET(
  _request: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const guard = await requireSessionOr401()
  if ('response' in guard) return guard.response

  const { id } = await params
  if (!id) return badRequest('Campaign id is required.')

  try {
    const db = await createSupabaseServerClient()
    return ok(await readCampaignSendSummary(db, id))
  } catch (error) {
    if (error instanceof Error && error.message === 'Campaign not found.') return notFound(error.message)
    return serverError(error, 'Could not read the send report.')
  }
}

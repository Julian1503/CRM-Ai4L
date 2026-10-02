import { createHmac } from 'node:crypto'

import type { APIRequestContext } from '@playwright/test'

/**
 * A stand-in for the content engine, for E2E only: it speaks the worker protocol v1
 * (docs/CONTENT_STUDIO_CONTRACTS.md §3) against the running CRM, signed with
 * CONTENT_WORKER_SECRET exactly as the engine signs, and never calls a provider.
 *
 * The HMAC is re-implemented here rather than imported from workerAuth.ts, which is
 * server-only; shared/content-contracts/fixtures/worker-signature.json pins both.
 */

const BASE_PATH = '/api/internal/content-worker/v1'

export function workerSecret(): string | null {
  const secret = process.env.CONTENT_WORKER_SECRET?.trim()
  return secret && secret.length >= 32 ? secret : null
}

export function signWorker(secret: string, timestamp: number, method: string, path: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${method}.${path}.${body}`, 'utf8').digest('hex')}`
}

export type ClaimedJob = { jobId: string; kind: string; claimToken: string; input: Record<string, unknown> }

export class FakeWorker {
  constructor(
    private readonly request: APIRequestContext,
    private readonly secret: string,
    private readonly workerId = `e2e-worker-${Date.now()}`
  ) {}

  async call<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    const path = `${BASE_PATH}/${op}`
    const body = JSON.stringify(payload)
    const timestamp = Math.floor(Date.now() / 1000)
    const response = await this.request.post(path, {
      data: body,
      headers: {
        'content-type': 'application/json',
        'x-content-worker-timestamp': String(timestamp),
        'x-content-worker-signature': signWorker(this.secret, timestamp, 'POST', path, body),
      },
    })
    if (!response.ok()) throw new Error(`Worker ${op} failed with ${response.status()}: ${await response.text()}`)
    return (await response.json()) as T
  }

  /**
   * Claims until it holds the generate_text job of `itemId`. Jobs of other items that it
   * happens to claim are handed straight back (retry, before any external effect).
   */
  async claimGeneration(itemId: string, attempts = 10): Promise<ClaimedJob> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const { jobs } = await this.call<{ jobs: ClaimedJob[] }>('claim', {
        workerId: this.workerId,
        kinds: ['generate_text'],
        limit: 20,
        leaseSeconds: 120,
      })
      const own = jobs.find((job) => job.input.itemId === itemId)
      for (const job of jobs.filter((entry) => entry !== own)) {
        await this.call('fail', { jobId: job.jobId, claimToken: job.claimToken, outcome: 'retry', errorCode: 'e2e_release', message: '' })
      }
      if (own) return own
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`No generation job for item ${itemId} became claimable.`)
  }

  /** Completes a claimed generation with one mock variant per requested channel. */
  async completeGeneration(job: ClaimedJob, bodyFor: (channel: string) => string): Promise<void> {
    await this.call('context', { jobId: job.jobId, claimToken: job.claimToken })
    const dispatch = await this.call<{ decision: string }>('begin-dispatch', { jobId: job.jobId, claimToken: job.claimToken })
    if (dispatch.decision !== 'go') throw new Error(`begin-dispatch answered ${dispatch.decision}`)

    const channels = (job.input.channels as string[] | undefined) ?? []
    const variants = channels.map((channel) => ({
      channel,
      style: 'e2e',
      body: bodyFor(channel),
      hashtags: ['AI4L'],
      callToAction: 'Book a call.',
      linkUrl: null,
      violations: [],
      ...(channel === 'email' ? { fields: { subject: 'E2E subject' } } : {}),
    }))
    const ack = await this.call<{ accepted: boolean }>('complete', {
      jobId: job.jobId,
      claimToken: job.claimToken,
      result: { variants, failures: [], promptVersion: 'e2e-mock-1', model: 'mock' },
    })
    if (!ack.accepted) throw new Error('The CRM did not accept the mock generation result.')
  }
}

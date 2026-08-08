/**
 * Token-bucket rate limiter.
 *
 * Modelled on the EmailOctopus limit: a bucket of 100 tokens refilling at 10 per
 * second. That shape matters because sending is per-recipient — a 10,000 contact
 * segment is 10,000 API calls, so roughly 16-17 minutes of queueing before any retry
 * handling. Pacing has to be built in rather than bolted on after the first 429.
 *
 * The clock and sleep are injected so the behaviour is testable without real delays.
 */

export const EMAILOCTOPUS_LIMIT = {
  capacity: 100,
  refillPerSecond: 10,
} as const

type TokenBucketOptions = {
  capacity: number
  refillPerSecond: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class TokenBucket {
  private readonly capacity: number
  private readonly refillPerSecond: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  private tokens: number
  private lastRefillMs: number
  /** Absolute time before which no request may go out, set by a provider 429. */
  private pausedUntilMs = 0

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity
    this.refillPerSecond = options.refillPerSecond
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

    this.tokens = options.capacity
    this.lastRefillMs = this.now()
  }

  private refill(): void {
    const nowMs = this.now()
    const elapsedMs = nowMs - this.lastRefillMs

    if (elapsedMs <= 0) return

    const gained = (elapsedMs / 1000) * this.refillPerSecond

    this.tokens = Math.min(this.capacity, this.tokens + gained)
    this.lastRefillMs = nowMs
  }

  /** Whole tokens currently available. */
  available(): number {
    this.refill()
    return Math.floor(this.tokens)
  }

  /**
   * Stalls the whole bucket until `ms` from now.
   *
   * Used when the provider returns 429 with Retry-After: backing off a single call
   * while the rest of the fan-out keeps firing just prolongs the rate limiting.
   */
  pauseFor(ms: number): void {
    this.pausedUntilMs = Math.max(this.pausedUntilMs, this.now() + ms)
  }

  /** Waits until a token is available, then spends it. */
  async acquire(): Promise<void> {
    const pauseMs = this.pausedUntilMs - this.now()

    if (pauseMs > 0) {
      await this.sleep(pauseMs)
    }

    this.refill()

    if (this.tokens < 1) {
      const deficit = 1 - this.tokens
      const waitMs = Math.ceil((deficit / this.refillPerSecond) * 1000)

      await this.sleep(waitMs)
      this.refill()
    }

    // Clamp at zero: a sleep shorter than requested must not push the count negative.
    this.tokens = Math.max(0, this.tokens - 1)
  }
}

/**
 * Estimates how long a batch takes to drain, for showing an honest duration before
 * someone approves a send.
 */
export function estimateDrainMs(
  count: number,
  limit: { capacity: number; refillPerSecond: number } = EMAILOCTOPUS_LIMIT
): number {
  const overflow = count - limit.capacity

  if (overflow <= 0) return 0

  return Math.round((overflow / limit.refillPerSecond) * 1000)
}

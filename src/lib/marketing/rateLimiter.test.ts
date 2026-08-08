import { TokenBucket, estimateDrainMs } from './rateLimiter'

describe('TokenBucket', () => {
  function bucket(overrides: Partial<ConstructorParameters<typeof TokenBucket>[0]> = {}) {
    let now = 0
    const sleep = jest.fn(async (ms: number) => {
      now += ms
    })

    const instance = new TokenBucket({
      capacity: 100,
      refillPerSecond: 10,
      now: () => now,
      sleep,
      ...overrides,
    })

    return {
      instance,
      sleep,
      advance: (ms: number) => {
        now += ms
      },
      get now() {
        return now
      },
    }
  }

  it('starts full', () => {
    const { instance } = bucket()

    expect(instance.available()).toBe(100)
  })

  it('spends a token per acquire', async () => {
    const { instance } = bucket()

    await instance.acquire()

    expect(instance.available()).toBe(99)
  })

  it('allows a burst up to capacity without waiting', async () => {
    const { instance, sleep } = bucket()

    for (let i = 0; i < 100; i += 1) {
      await instance.acquire()
    }

    expect(sleep).not.toHaveBeenCalled()
    expect(instance.available()).toBe(0)
  })

  it('waits once the burst is exhausted', async () => {
    const { instance, sleep } = bucket()

    for (let i = 0; i < 100; i += 1) {
      await instance.acquire()
    }
    await instance.acquire()

    expect(sleep).toHaveBeenCalledTimes(1)
    // 10 tokens/sec means one token every 100ms.
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(0)
    expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(100)
  })

  it('refills over time', async () => {
    const { instance, advance } = bucket()

    for (let i = 0; i < 100; i += 1) {
      await instance.acquire()
    }
    expect(instance.available()).toBe(0)

    advance(1000)

    expect(instance.available()).toBe(10)
  })

  it('never refills beyond capacity', async () => {
    const { instance, advance } = bucket()

    advance(60_000)

    expect(instance.available()).toBe(100)
  })

  it('does not go negative under sustained load', async () => {
    const { instance } = bucket()

    for (let i = 0; i < 150; i += 1) {
      await instance.acquire()
    }

    expect(instance.available()).toBeGreaterThanOrEqual(0)
  })

  it('honours a provider-imposed pause', async () => {
    // A 429 with Retry-After should stall the whole bucket, not just one call.
    const { instance, sleep } = bucket()

    instance.pauseFor(5000)
    await instance.acquire()

    expect(sleep).toHaveBeenCalledWith(5000)
  })

  it('applies the longest pause when several are requested', async () => {
    const { instance, sleep } = bucket()

    instance.pauseFor(1000)
    instance.pauseFor(8000)
    await instance.acquire()

    expect(sleep).toHaveBeenCalledWith(8000)
  })
})

describe('estimateDrainMs', () => {
  it('is zero when the whole batch fits in the initial burst', () => {
    expect(estimateDrainMs(100, { capacity: 100, refillPerSecond: 10 })).toBe(0)
  })

  it('charges only the overflow against the refill rate', () => {
    // 110 recipients: 100 burst immediately, 10 more at 10/sec = 1 second.
    expect(estimateDrainMs(110, { capacity: 100, refillPerSecond: 10 })).toBe(1000)
  })

  it('matches the documented ~17 minutes for a 10k segment', () => {
    // 10,000 - 100 burst = 9,900 at 10/sec = 990s = 16.5 minutes.
    const ms = estimateDrainMs(10_000, { capacity: 100, refillPerSecond: 10 })

    expect(ms / 60_000).toBeGreaterThan(16)
    expect(ms / 60_000).toBeLessThan(17)
  })

  it('is zero for an empty batch', () => {
    expect(estimateDrainMs(0, { capacity: 100, refillPerSecond: 10 })).toBe(0)
  })
})

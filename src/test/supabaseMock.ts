/**
 * Chainable Supabase query-builder double.
 *
 * Records every chained call so tests can assert the query that *would* be sent,
 * without a database. `resolveWith` decides what awaiting the builder returns.
 */
export type RecordedCall = { method: string; args: unknown[] }

const CHAINABLE = [
  'select',
  'eq',
  'neq',
  'is',
  'not',
  'or',
  'ilike',
  'in',
  'lte',
  'gte',
  'order',
  'range',
  'limit',
  'update',
  'insert',
  'upsert',
  'delete',
  'single',
  'maybeSingle',
] as const

type ChainableMethod = (typeof CHAINABLE)[number]

export type QueryBuilderMock = {
  calls: RecordedCall[]
  /** Arguments of the first call to `method`, or undefined. */
  argsFor(method: string): unknown[] | undefined
  /** Every call to `method`. */
  allFor(method: string): RecordedCall[]
  /** Awaiting the builder resolves like a PostgREST response. */
  then(onFulfilled: (value: unknown) => unknown): Promise<unknown>
} & {
  // `unknown[]` rest params keep the mock structurally assignable to the narrower
  // query-builder interfaces under test (e.g. `eq(column: string, value: unknown)`).
  [K in ChainableMethod]: (...args: unknown[]) => QueryBuilderMock
}

/**
 * @param resolveWith A single response, or an array consumed one per await — the
 * latter is needed for multi-step flows (look up, then insert or update) where each
 * step returns something different.
 */
export function createQueryBuilderMock(
  resolveWith: unknown = { data: [], error: null, count: 0 }
): QueryBuilderMock {
  const calls: RecordedCall[] = []
  const queue = Array.isArray(resolveWith) ? [...resolveWith] : null

  const builder: Record<string, unknown> = {
    calls,
    argsFor(method: string) {
      return calls.find((call) => call.method === method)?.args
    },
    allFor(method: string) {
      return calls.filter((call) => call.method === method)
    },
    then(onFulfilled: (value: unknown) => unknown) {
      // Once the queue is drained, keep returning the final response rather than
      // undefined — an over-await should not produce a confusing TypeError.
      const next =
        queue === null
          ? resolveWith
          : queue.length > 1
            ? queue.shift()
            : queue[0]

      return Promise.resolve(next).then(onFulfilled)
    },
  }

  CHAINABLE.forEach((method) => {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return builder
    }
  })

  return builder as unknown as QueryBuilderMock
}

export type DbMock = { from: jest.Mock; rpc: jest.Mock }

/**
 * A `db`-shaped object.
 *
 * Pass a single builder to have every `.from()` return it, or a resolver to vary the
 * builder per table — needed when one request touches several tables.
 */
export function createDbMock(
  builderOrResolver: unknown | ((table: string) => unknown)
): DbMock {
  const resolve =
    typeof builderOrResolver === 'function'
      ? (builderOrResolver as (table: string) => unknown)
      : () => builderOrResolver

  return {
    from: jest.fn((table: string) => resolve(table)),
    // Resolves like a successful PostgREST call by default. A bare `jest.fn()` returns
    // undefined, and every caller destructures `{ data, error }` off the result — so an
    // un-stubbed rpc used to fail as a TypeError rather than as the assertion the test
    // was actually making.
    rpc: jest.fn(async () => ({ data: null, error: null })),
  }
}

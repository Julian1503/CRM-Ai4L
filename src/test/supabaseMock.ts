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
  'order',
  'range',
  'limit',
  'update',
  'insert',
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

export function createQueryBuilderMock(
  resolveWith: unknown = { data: [], error: null, count: 0 }
): QueryBuilderMock {
  const calls: RecordedCall[] = []

  const builder: Record<string, unknown> = {
    calls,
    argsFor(method: string) {
      return calls.find((call) => call.method === method)?.args
    },
    allFor(method: string) {
      return calls.filter((call) => call.method === method)
    },
    then(onFulfilled: (value: unknown) => unknown) {
      return Promise.resolve(resolveWith).then(onFulfilled)
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

/** A `db`-shaped object whose `.from()` always returns the given builder. */
export function createDbMock(builder: unknown): DbMock {
  return {
    from: jest.fn(() => builder),
    rpc: jest.fn(),
  }
}

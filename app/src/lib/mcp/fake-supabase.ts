/**
 * TEST-ONLY fake of the small slice of the supabase-js query builder the MCP
 * tools use. Not imported by any runtime code path.
 *
 * It exists so tool handlers can be exercised end to end (register the tool,
 * call it, assert on the JSON it returns) without a database, which is the
 * only way to test things like estimate-to-invoice conversion math or that a
 * handler refuses an out-of-scope row.
 *
 * Supported chain: from(table).select(...).eq/neq/in/is/not/ilike/gt/gte/lt/lte/order/limit
 * terminated by await, .maybeSingle(), or .single(); plus .insert(), .update(),
 * .delete().
 *
 * Also supports rpc(fn, args), which is how every transactional write reaches
 * the database. Without it those call sites could not be
 * exercised at all, which is why record_payment briefly lost its coverage.
 */

export interface FakeQuery {
  /** Table name, or for an rpc call the Postgres function name. */
  table: string
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc'
  /** Set only when op is "rpc". Same value as `table`, spelled for readability. */
  fn?: string
  filters: { method: string; args: unknown[] }[]
  /** Insert/update payload, or for an rpc call the named-argument object. */
  payload?: unknown
}

export type FakeResult = { data: unknown; error: unknown }

export type FakeHandler = (query: FakeQuery) => FakeResult

export interface FakeSupabase {
  from: (table: string) => unknown
  rpc: (fn: string, args?: unknown) => unknown
  /** Every query the code under test issued, in order. */
  calls: FakeQuery[]
}

const CHAIN_METHODS = [
  'select',
  'eq',
  'neq',
  'in',
  'is',
  'not',
  'ilike',
  'gt',
  'gte',
  'lt',
  'lte',
  'order',
  'limit',
  'range',
] as const

/**
 * @param handlers map of `"<table>.<op>"` (e.g. "invoices.insert") to the
 * result that query should resolve to. RPC calls are keyed
 * `"rpc.<function>"` (e.g. "rpc.record_invoice_payment"). Falls back to the
 * bare table or function name, then to an empty result, so tests only spell
 * out what they care about.
 */
export function createFakeSupabase(handlers: Record<string, FakeHandler | FakeResult>): FakeSupabase {
  const calls: FakeQuery[] = []

  function resolve(query: FakeQuery): FakeResult {
    const key = query.op === 'rpc' ? `rpc.${query.table}` : `${query.table}.${query.op}`
    const handler = handlers[key] ?? handlers[query.table]
    if (!handler) return { data: null, error: null }
    return typeof handler === 'function' ? handler(query) : handler
  }

  function makeChain(query: FakeQuery) {
    const chain: Record<string, unknown> = {}

    for (const method of CHAIN_METHODS) {
      chain[method] = (...args: unknown[]) => {
        query.filters.push({ method, args })
        return chain
      }
    }

    chain.maybeSingle = async () => resolve(query)
    chain.single = async () => resolve(query)
    chain.then = (onFulfilled: (value: FakeResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(resolve(query)).then(onFulfilled, onRejected)

    return chain
  }

  return {
    calls,
    /**
     * Mirrors supabase-js: `.rpc()` resolves straight to `{ data, error }`
     * where data is whatever the function returned, and may additionally be
     * narrowed with `.single()` when the function returns SETOF.
     */
    rpc(fn: string, args?: unknown) {
      const query: FakeQuery = { table: fn, op: 'rpc', fn, filters: [], payload: args }
      calls.push(query)
      return makeChain(query)
    },
    from(table: string) {
      const start = (op: FakeQuery['op'], payload?: unknown) => {
        const query: FakeQuery = { table, op, filters: [], payload }
        calls.push(query)
        return makeChain(query)
      }

      return {
        select: (...args: unknown[]) => {
          const chain = start('select') as Record<string, (...a: unknown[]) => unknown>
          return chain.select(...args)
        },
        insert: (payload: unknown) => start('insert', payload),
        update: (payload: unknown) => start('update', payload),
        delete: () => start('delete'),
      }
    },
  }
}

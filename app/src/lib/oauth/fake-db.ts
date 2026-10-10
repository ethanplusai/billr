/**
 * TEST-ONLY in-memory stand-in for the slice of the Supabase query builder
 * src/lib/oauth/store.ts uses. Not imported by any runtime code path.
 *
 * It exists because the interesting parts of the OAuth server are exactly the
 * ones a mocked-out store would paper over: a code being redeemable exactly
 * once, a rotated refresh token revoking its whole family, a superseded access
 * key being marked revoked. Those are properties of the QUERIES, so the tests
 * run the real store against real rows held in a JavaScript object.
 *
 * Supported: from(table).select/insert/update/delete chained with
 * eq/is/in/lt/order/limit, terminated by await, .maybeSingle() or .single().
 *
 * It does NOT resolve PostgREST resource embedding, and that is deliberate.
 * Embedding `other_table(column)` needs SELECT on `other_table` for the
 * QUERYING role, which several of these tables revoke outright, so a fake that
 * happily resolved a join would report a query working that the database
 * refuses. Every requested column list is recorded in `selects` instead, so a
 * test can assert what was actually asked for.
 */
import { randomUUID } from 'node:crypto'

export type Row = Record<string, unknown>

type Filter = { method: 'eq' | 'is' | 'in' | 'lt'; column: string; value: unknown }

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const actual = row[filter.column]
    switch (filter.method) {
      case 'eq':
        return actual === filter.value
      case 'is':
        return filter.value === null ? actual == null : actual === filter.value
      case 'in':
        return Array.isArray(filter.value) && filter.value.includes(actual)
      case 'lt':
        return (
          typeof actual === 'string' &&
          typeof filter.value === 'string' &&
          actual < filter.value
        )
    }
  })
}

export interface FakeDb {
  tables: Record<string, Row[]>
  /** Every column list this fake was asked for, in order. */
  selects: { table: string; columns: string }[]
  /** Cast at the call site; it only implements what the store calls. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any
}

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {}
  const selects: { table: string; columns: string }[] = []
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }))

  function rowsFor(table: string): Row[] {
    if (!tables[table]) tables[table] = []
    return tables[table]
  }

  function makeQuery(table: string, op: 'select' | 'insert' | 'update' | 'delete', payload?: Row) {
    const filters: Filter[] = []

    function run(): Row[] {
      const rows = rowsFor(table)
      if (op === 'insert') {
        const inserted: Row = {
          id: randomUUID(),
          created_at: new Date().toISOString(),
          ...payload,
        }
        rows.push(inserted)
        return [{ ...inserted }]
      }
      const hit = rows.filter((row) => matches(row, filters))
      if (op === 'select') return hit.map((row) => ({ ...row }))
      if (op === 'update') {
        for (const row of hit) Object.assign(row, payload)
        return hit.map((row) => ({ ...row }))
      }
      for (const row of hit) rows.splice(rows.indexOf(row), 1)
      return hit.map((row) => ({ ...row }))
    }

    const chain: Record<string, unknown> = {
      eq: (column: string, value: unknown) => {
        filters.push({ method: 'eq', column, value })
        return chain
      },
      is: (column: string, value: unknown) => {
        filters.push({ method: 'is', column, value })
        return chain
      },
      in: (column: string, value: unknown) => {
        filters.push({ method: 'in', column, value })
        return chain
      },
      lt: (column: string, value: unknown) => {
        filters.push({ method: 'lt', column, value })
        return chain
      },
      select: (columns?: string) => {
        if (typeof columns === 'string') selects.push({ table, columns })
        return chain
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => {
        const [row] = run()
        return row ? { data: row, error: null } : { data: null, error: { message: 'no rows' } }
      },
      then: (
        onFulfilled: (value: { data: Row[]; error: null }) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) => Promise.resolve({ data: run(), error: null }).then(onFulfilled, onRejected),
    }
    return chain
  }

  const client = {
    from(table: string) {
      return {
        select: (columns?: string) => {
          if (typeof columns === 'string') selects.push({ table, columns })
          return makeQuery(table, 'select')
        },
        insert: (payload: Row) => makeQuery(table, 'insert', payload),
        update: (payload: Row) => makeQuery(table, 'update', payload),
        delete: () => makeQuery(table, 'delete'),
      }
    },
  }

  return { tables, selects, client }
}

/** Rate limiter stub that always allows, so limits never mask a real failure. */
export function allowAllRateLimitStore() {
  return {
    rpc: async () => ({
      data: [{ allowed: true, remaining: 100, retry_after_seconds: 0 }],
      error: null,
    }),
  }
}

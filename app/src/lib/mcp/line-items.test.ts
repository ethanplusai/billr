import { describe, it, expect } from 'vitest'
import { createFakeSupabase, type FakeQuery } from './fake-supabase'
import { createScopedDb, ScopeError } from './scoped-db'
import { resolveLineItems, lineItemInput } from './line-items'
import { computeInvoiceTotals } from '@/lib/invoices/build'
import type { McpCtx } from './context'

interface CatalogItem {
  id: string
  business_id: string
  name: string
  description: string | null
  type: string
  rate: number
  unit: string | null
  tax_rate: number
  is_active: boolean
}

const CONSULTING: CatalogItem = {
  id: '11111111-1111-4111-8111-111111111111',
  business_id: 'b1',
  name: 'Consulting',
  description: 'Consulting services',
  type: 'service',
  rate: 150,
  unit: 'hour',
  tax_rate: 0,
  is_active: true,
}

const DESIGN: CatalogItem = {
  ...CONSULTING,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Design',
  description: null,
  rate: 90,
}

/** Reads back the value passed to a given chain method, e.g. the ilike pattern. */
function argOf(query: FakeQuery, method: string, index: number): unknown {
  return query.filters.find((f) => f.method === method)?.args[index]
}

function ctxWithCatalog(catalog: CatalogItem[]): McpCtx {
  const svc = createFakeSupabase({
    'items.select': (query) => {
      const pattern = argOf(query, 'ilike', 1) as string | undefined
      if (pattern === undefined) return { data: catalog, error: null }

      // Exact lookups pass the bare name; the "did you mean" pass wraps it in %.
      if (pattern.startsWith('%') && pattern.endsWith('%')) {
        const needle = pattern.slice(1, -1).toLowerCase()
        return { data: catalog.filter((i) => i.name.toLowerCase().includes(needle)), error: null }
      }
      return { data: catalog.filter((i) => i.name.toLowerCase() === pattern.toLowerCase()), error: null }
    },
  })

  return {
    userId: 'u1',
    keyId: 'k1',
    businessIds: ['b1'],
    db: createScopedDb({ userId: 'u1', businessIds: ['b1'] }, svc as never),
  }
}

describe('resolveLineItems saved-item lookup', () => {
  it('prices a line from a saved item named in plain language', async () => {
    const ctx = ctxWithCatalog([CONSULTING, DESIGN])
    const { resolved } = await resolveLineItems(ctx, 'b1', [{ item_name: 'Consulting', quantity: 3 }])

    expect(resolved).toEqual([{ description: 'Consulting services', quantity: 3, rate: 150 }])
  })

  it('matches the item name case-insensitively', async () => {
    const ctx = ctxWithCatalog([CONSULTING, DESIGN])
    const { resolved } = await resolveLineItems(ctx, 'b1', [{ item_name: 'consulting', quantity: 1 }])
    expect(resolved[0].rate).toBe(150)
  })

  it('falls back to the item name when the item has no description', async () => {
    const ctx = ctxWithCatalog([CONSULTING, DESIGN])
    const { resolved } = await resolveLineItems(ctx, 'b1', [{ item_name: 'Design', quantity: 2 }])
    expect(resolved).toEqual([{ description: 'Design', quantity: 2, rate: 90 }])
  })

  it('defaults quantity to 1 when the caller does not say', async () => {
    const ctx = ctxWithCatalog([CONSULTING])
    const { resolved } = await resolveLineItems(ctx, 'b1', [{ item_name: 'Consulting' }])
    expect(resolved[0].quantity).toBe(1)
  })

  it('lets an explicit rate override the saved rate for that line only', async () => {
    const ctx = ctxWithCatalog([CONSULTING])
    const { resolved } = await resolveLineItems(ctx, 'b1', [
      { item_name: 'Consulting', quantity: 1, rate: 125 },
      { item_name: 'Consulting', quantity: 1 },
    ])
    expect(resolved.map((line) => line.rate)).toEqual([125, 150])
  })

  it('lets an explicit description override the saved one', async () => {
    const ctx = ctxWithCatalog([CONSULTING])
    const { resolved } = await resolveLineItems(ctx, 'b1', [
      { item_name: 'Consulting', description: 'Discovery workshop', quantity: 1 },
    ])
    expect(resolved[0]).toEqual({ description: 'Discovery workshop', quantity: 1, rate: 150 })
  })

  it('suggests near matches instead of guessing when the name is wrong', async () => {
    const ctx = ctxWithCatalog([CONSULTING, DESIGN])
    await expect(resolveLineItems(ctx, 'b1', [{ item_name: 'Consult' }])).rejects.toThrow(/Did you mean/)
  })

  it('refuses to pick a side when two items share a name', async () => {
    const twin = { ...DESIGN, name: 'Consulting' }
    const ctx = ctxWithCatalog([CONSULTING, twin])
    await expect(resolveLineItems(ctx, 'b1', [{ item_name: 'Consulting' }])).rejects.toThrow(
      /pass item_id to disambiguate/
    )
  })

  it('reports which line is missing a rate rather than billing zero', async () => {
    const ctx = ctxWithCatalog([CONSULTING])
    await expect(
      resolveLineItems(ctx, 'b1', [
        { description: 'Fine', quantity: 1, rate: 10 },
        { description: 'No rate', quantity: 1 },
      ])
    ).rejects.toThrow(/Missing rate on line 2/)
  })

  it('reports a missing description as a ScopeError, never a raw throw', async () => {
    const ctx = ctxWithCatalog([CONSULTING])
    await expect(resolveLineItems(ctx, 'b1', [{ quantity: 1, rate: 10 }])).rejects.toBeInstanceOf(ScopeError)
  })

  it('scopes the catalog lookup to the resolved business', async () => {
    const ctx = ctxWithCatalog([CONSULTING])
    await resolveLineItems(ctx, 'b1', [{ item_name: 'Consulting' }])
    const svcCalls = (ctx.db.svc as unknown as { calls: FakeQuery[] }).calls
    const itemQuery = svcCalls.find((c) => c.table === 'items')!
    expect(itemQuery.filters).toContainEqual({ method: 'eq', args: ['business_id', 'b1'] })
  })

  it('escapes ilike wildcards so a literal % in a name is not a pattern', async () => {
    const ctx = ctxWithCatalog([{ ...CONSULTING, name: '50% Off Retainer' }])
    await resolveLineItems(ctx, 'b1', [{ item_name: '50% Off Retainer' }]).catch(() => {})
    const svcCalls = (ctx.db.svc as unknown as { calls: FakeQuery[] }).calls
    expect(argOf(svcCalls[0], 'ilike', 1)).toBe('50\\% Off Retainer')
  })
})

describe('lineItemInput schema', () => {
  it('accepts a bare saved-item reference', () => {
    expect(lineItemInput.parse({ item_name: 'Consulting', quantity: 3 })).toMatchObject({ quantity: 3 })
  })

  it('rejects a zero or negative quantity', () => {
    expect(() => lineItemInput.parse({ description: 'x', quantity: 0, rate: 1 })).toThrow()
    expect(() => lineItemInput.parse({ description: 'x', quantity: -1, rate: 1 })).toThrow()
  })

  it('rejects a negative rate', () => {
    expect(() => lineItemInput.parse({ description: 'x', quantity: 1, rate: -1 })).toThrow()
  })

  it('describes every field, since the description is what the agent reads', () => {
    for (const field of Object.values(lineItemInput.shape)) {
      expect(field.description).toBeTruthy()
    }
  })
})

describe('item-priced lines feed the round-once totals math', () => {
  it('makes the subtotal equal the sum of displayed line amounts', async () => {
    const halfCentItem = { ...CONSULTING, rate: 0.005, description: 'Half cent' }
    const ctx = ctxWithCatalog([halfCentItem])
    const { resolved } = await resolveLineItems(ctx, 'b1', [
      { item_name: 'Consulting' },
      { item_name: 'Consulting' },
      { item_name: 'Consulting' },
    ])

    const totals = computeInvoiceTotals(resolved)

    // Each line rounds up to a cent on its own, but the subtotal comes from the
    // raw 0.015, so summing the rounded lines (0.03) would be wrong.
    expect(totals.line_items.map((li) => li.amount)).toEqual([0.01, 0.01, 0.01])
    expect(totals.subtotal).toBe(0.03)
    expect(totals.total).toBe(0.03)
  })
})

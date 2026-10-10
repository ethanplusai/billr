import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import { createFakeSupabase, type FakeHandler, type FakeResult } from '@/lib/mcp/fake-supabase'
import { createScopedDb } from '@/lib/mcp/scoped-db'
import { registerTimeTools } from './time'
import { registerExpenseTools } from './expenses'
import type { McpCtx } from '@/lib/mcp/context'

interface Registered {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => Promise<{ content: { text: string }[]; isError?: true }>
  description: string
}

const TIME_ENTRY = {
  id: 't1',
  business_id: 'b1',
  client_id: 'c1',
  description: 'Discovery call',
  date: '2026-08-20',
  duration_minutes: 90,
  hourly_rate: 100,
  amount: 150,
  is_billable: true,
  is_billed: false,
  invoice_id: null,
}

const EXPENSE = {
  id: 'x1',
  business_id: 'b1',
  client_id: 'c1',
  description: 'Design tool',
  vendor: 'Figma',
  category: 'software',
  date: '2026-08-20',
  amount: 45,
  currency: 'USD',
  is_billable: true,
  is_billed: false,
  invoice_id: null,
}

function setup(overrides: Record<string, FakeHandler | FakeResult> = {}) {
  const svc = createFakeSupabase({
    'time_entries.select': { data: TIME_ENTRY, error: null },
    'time_entries.update': (query) => ({ data: { ...TIME_ENTRY, ...(query.payload as object) }, error: null }),
    'time_entries.delete': { data: null, error: null },
    'expenses.select': { data: EXPENSE, error: null },
    'expenses.update': (query) => ({ data: { ...EXPENSE, ...(query.payload as object) }, error: null }),
    'expenses.delete': { data: null, error: null },
    ...overrides,
  })

  const ctx: McpCtx = {
    userId: 'u1',
    keyId: 'key1',
    businessIds: ['b1'],
    db: createScopedDb({ userId: 'u1', businessIds: ['b1'] }, svc as never),
  }

  const tools = new Map<string, Registered>()
  const server = {
    registerTool: (name: string, def: { description: string; inputSchema: unknown }, handler: unknown) => {
      tools.set(name, {
        inputSchema: def.inputSchema,
        handler: handler as Registered['handler'],
        description: def.description,
      })
    },
  } as unknown as McpServer

  registerTimeTools(server, ctx)
  registerExpenseTools(server, ctx)
  return { svc, tools }
}

function body(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('delete tools are narrow by construction', () => {
  it('accepts nothing but a single explicit id', () => {
    const { tools } = setup()
    expect(Object.keys(tools.get('delete_time_entry')!.inputSchema.shape)).toEqual(['time_entry_id'])
    expect(Object.keys(tools.get('delete_expense')!.inputSchema.shape)).toEqual(['expense_id'])
  })

  it('requires that id rather than defaulting to a bulk delete', () => {
    const { tools } = setup()
    expect(() => tools.get('delete_time_entry')!.inputSchema.parse({})).toThrow()
    expect(() => tools.get('delete_expense')!.inputSchema.parse({})).toThrow()
  })

  it('returns what was deleted so it can be re-logged', async () => {
    const { tools } = setup()
    const time = body(await tools.get('delete_time_entry')!.handler({ time_entry_id: 't1' }))
    expect(time.deleted_time_entry).toMatchObject({ id: 't1', hours: 1.5, rate: 100, amount: 150 })

    const expense = body(await tools.get('delete_expense')!.handler({ expense_id: 'x1' }))
    expect(expense.deleted_expense).toMatchObject({ id: 'x1', amount: 45, currency: 'USD' })
  })

  it('constrains the delete to the row id and its business', async () => {
    const { tools, svc } = setup()
    await tools.get('delete_time_entry')!.handler({ time_entry_id: 't1' })

    const del = svc.calls.find((c) => c.table === 'time_entries' && c.op === 'delete')!
    expect(del.filters).toContainEqual({ method: 'eq', args: ['id', 't1'] })
    expect(del.filters).toContainEqual({ method: 'eq', args: ['business_id', 'b1'] })
  })

  it('refuses a row that is already billed', async () => {
    const { tools, svc } = setup({
      'time_entries.select': { data: { ...TIME_ENTRY, invoice_id: 'inv9' }, error: null },
      'expenses.select': { data: { ...EXPENSE, invoice_id: 'inv9' }, error: null },
    })

    const time = await tools.get('delete_time_entry')!.handler({ time_entry_id: 't1' })
    expect(time.isError).toBe(true)
    expect(time.content[0].text).toContain('inv9')

    const expense = await tools.get('delete_expense')!.handler({ expense_id: 'x1' })
    expect(expense.isError).toBe(true)

    expect(svc.calls.some((c) => c.op === 'delete')).toBe(false)
  })

  it('refuses a row belonging to another business, via ScopedDb', async () => {
    const { tools, svc } = setup({
      'time_entries.select': { data: { ...TIME_ENTRY, business_id: 'bX' }, error: null },
    })
    const result = await tools.get('delete_time_entry')!.handler({ time_entry_id: 't1' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Time entry not found')
    expect(svc.calls.some((c) => c.op === 'delete')).toBe(false)
  })
})

describe('update_time_entry', () => {
  it('recomputes the amount from the post-update hours and rate', async () => {
    const { tools, svc } = setup()
    await tools.get('update_time_entry')!.handler({ time_entry_id: 't1', hours: 2 })

    const payload = svc.calls.find((c) => c.table === 'time_entries' && c.op === 'update')!.payload as Record<
      string,
      unknown
    >
    expect(payload.duration_seconds).toBe(7200)
    // Existing rate of 100 applies to the new hours, not the old amount.
    expect(payload.amount).toBe(200)
  })

  it('keeps a null rate null rather than inventing a zero amount', async () => {
    const { tools, svc } = setup({
      'time_entries.select': { data: { ...TIME_ENTRY, hourly_rate: null, amount: null }, error: null },
    })
    await tools.get('update_time_entry')!.handler({ time_entry_id: 't1', hours: 2 })

    const payload = svc.calls.find((c) => c.table === 'time_entries' && c.op === 'update')!.payload as Record<
      string,
      unknown
    >
    expect(payload.amount).toBeNull()
  })

  it('leaves the amount alone when neither hours nor rate changed', async () => {
    const { tools, svc } = setup()
    await tools.get('update_time_entry')!.handler({ time_entry_id: 't1', description: 'Renamed' })

    const payload = svc.calls.find((c) => c.table === 'time_entries' && c.op === 'update')!.payload as Record<
      string,
      unknown
    >
    expect(payload).toEqual({ description: 'Renamed' })
  })

  it('rejects an empty update instead of writing nothing silently', async () => {
    const { tools } = setup()
    const result = await tools.get('update_time_entry')!.handler({ time_entry_id: 't1' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Nothing to update')
  })

  it('refuses to edit an entry already on an invoice', async () => {
    const { tools, svc } = setup({
      'time_entries.select': { data: { ...TIME_ENTRY, invoice_id: 'inv9' }, error: null },
    })
    const result = await tools.get('update_time_entry')!.handler({ time_entry_id: 't1', hours: 3 })

    expect(result.isError).toBe(true)
    expect(svc.calls.some((c) => c.op === 'update')).toBe(false)
  })
})

describe('update_expense', () => {
  it('applies only the fields the caller passed', async () => {
    const { tools, svc } = setup()
    await tools.get('update_expense')!.handler({ expense_id: 'x1', amount: 60, category: 'travel' })

    const payload = svc.calls.find((c) => c.table === 'expenses' && c.op === 'update')!.payload
    expect(payload).toEqual({ amount: 60, category: 'travel' })
  })

  it('refuses to edit an expense already on an invoice', async () => {
    const { tools, svc } = setup({ 'expenses.select': { data: { ...EXPENSE, invoice_id: 'inv9' }, error: null } })
    const result = await tools.get('update_expense')!.handler({ expense_id: 'x1', amount: 60 })

    expect(result.isError).toBe(true)
    expect(svc.calls.some((c) => c.op === 'update')).toBe(false)
  })
})

describe('list tools', () => {
  it('groups expense totals per currency rather than summing across them', async () => {
    const { tools } = setup({
      'expenses.select': {
        data: [
          { ...EXPENSE, id: 'x1', amount: 10, currency: 'USD' },
          { ...EXPENSE, id: 'x2', amount: 20, currency: 'EUR' },
          { ...EXPENSE, id: 'x3', amount: 5, currency: 'USD' },
        ],
        error: null,
      },
    })
    const json = body(await tools.get('list_expenses')!.handler({}))

    expect(json.totals_by_currency).toEqual([
      { currency: 'USD', total: 15 },
      { currency: 'EUR', total: 20 },
    ])
  })

  it('converts stored minutes back into hours and totals them', async () => {
    const { tools } = setup({
      'time_entries.select': {
        data: [
          { ...TIME_ENTRY, id: 't1', duration_minutes: 90 },
          { ...TIME_ENTRY, id: 't2', duration_minutes: 30 },
        ],
        error: null,
      },
    })
    const json = body(await tools.get('list_time_entries')!.handler({}))

    expect(json.entries.map((e: { hours: number }) => e.hours)).toEqual([1.5, 0.5])
    expect(json.total_hours).toBe(2)
  })

  it('filters unbilled work with a null invoice_id rather than the is_billed flag', async () => {
    const { tools, svc } = setup({ 'time_entries.select': { data: [], error: null } })
    await tools.get('list_time_entries')!.handler({ billed: 'unbilled' })

    const query = svc.calls.find((c) => c.table === 'time_entries')!
    expect(query.filters).toContainEqual({ method: 'is', args: ['invoice_id', null] })
  })
})

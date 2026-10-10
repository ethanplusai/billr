import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import { createFakeSupabase, type FakeQuery, type FakeHandler, type FakeResult } from '@/lib/mcp/fake-supabase'
import { createScopedDb } from '@/lib/mcp/scoped-db'
import { registerInvoiceWriteTools } from './invoices-write'
import type { McpCtx } from '@/lib/mcp/context'

interface Registered {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => Promise<{ content: { text: string }[]; isError?: true }>
}

const BUSINESS = {
  id: 'b1',
  name: 'Acme',
  default_currency: 'USD',
  default_payment_terms: 14,
  invoice_prefix: 'INV',
  next_invoice_number: 42,
  estimate_prefix: 'EST',
  next_estimate_number: 7,
  invoice_notes: null,
  invoice_footer: null,
}

const CLIENT = { id: 'c1', business_id: 'b1', name: 'Globex', currency: 'USD', email: 'ap@globex.test' }

const DRAFT_INVOICE = {
  id: 'inv1',
  business_id: 'b1',
  client_id: 'c1',
  public_id: 'invpub',
  invoice_number: 'INV-0042',
  status: 'draft',
  currency: 'USD',
  issue_date: '2026-08-01',
  due_date: '2026-08-15',
  subtotal: 100,
  discount_type: 'percentage',
  discount_value: 0,
  discount_amount: 0,
  tax_rate: 0,
  tax_amount: 0,
  shipping_amount: 0,
  total: 100,
  amount_paid: 0,
  balance_due: 100,
  notes: null,
}

const STORED_LINES = [{ description: 'Original', quantity: 1, rate: 100, sort_order: 0 }]

function setup(overrides: Record<string, FakeHandler | FakeResult> = {}) {
  const svc = createFakeSupabase({
    'businesses.select': { data: BUSINESS, error: null },
    'clients.select': (query) =>
      query.filters.some((f) => f.method === 'ilike')
        ? { data: [CLIENT], error: null }
        : { data: CLIENT, error: null },
    'invoices.select': { data: DRAFT_INVOICE, error: null },
    'invoices.insert': (query) => ({
      data: { ...(query.payload as object), id: 'inv1', public_id: 'invpub' },
      error: null,
    }),
    'invoices.update': (query) => ({ data: { ...DRAFT_INVOICE, ...(query.payload as object) }, error: null }),
    'invoice_line_items.select': { data: STORED_LINES, error: null },
    'invoice_line_items.insert': { data: null, error: null },
    'rpc.create_invoice_document': {
      data: DRAFT_INVOICE,
      error: null,
    },
    'rpc.replace_invoice_line_items': (query) => ({
      data: { ...DRAFT_INVOICE, ...((query.payload as { p_invoice_patch: object }).p_invoice_patch ?? {}) },
      error: null,
    }),
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
    registerTool: (name: string, _def: unknown, handler: unknown) => {
      tools.set(name, { handler: handler as Registered['handler'] })
    },
  } as unknown as McpServer

  registerInvoiceWriteTools(server, ctx)
  return { svc, tools }
}

function rpcCalls(svc: { calls: FakeQuery[] }, fn: string) {
  return svc.calls.filter((c) => c.op === 'rpc' && c.table === fn)
}

function payloadOf(svc: { calls: FakeQuery[] }, table: string, op: FakeQuery['op']) {
  return svc.calls.find((c) => c.table === table && c.op === op)?.payload as Record<string, unknown> | undefined
}

function body(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('create_invoice numbering', () => {
  it('creates the invoice and claims work through one retryable transaction', async () => {
    const { tools, svc } = setup()
    await tools.get('create_invoice')!.handler({
      client_name: 'Globex',
      request_id: '10000000-0000-4000-8000-000000000001',
      line_items: [{ description: 'Work', quantity: 2, rate: 50 }],
    })

    const calls = rpcCalls(svc, 'create_invoice_document')
    expect(calls).toHaveLength(1)
    expect(calls[0].payload).toMatchObject({ p_business_id: 'b1', p_client_id: 'c1', p_request_id: '10000000-0000-4000-8000-000000000001' })
    expect(payloadOf(svc, 'invoices', 'insert')).toBeUndefined()

    // The counter is advanced inside that same statement. Writing
    // businesses.next_invoice_number = read + 1 by hand, which is what this
    // replaces, gave two concurrent creates the same number.
    expect(svc.calls.some((c) => c.table === 'businesses' && c.op === 'update')).toBe(false)
  })

  it('writes no invoice at all when no number can be allocated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tools, svc } = setup({
      'rpc.create_invoice_document': { data: null, error: { message: 'forbidden' } },
    })
    const result = await tools.get('create_invoice')!.handler({
      client_name: 'Globex',
      request_id: '10000000-0000-4000-8000-000000000001',
      line_items: [{ description: 'Work', quantity: 1, rate: 10 }],
    })

    expect(result.isError).toBe(true)
    expect(svc.calls.some((c) => c.table === 'invoices' && c.op === 'insert')).toBe(false)
  })
})

/**
 * Billing agreed work off an engagement schedule. The tool
 * layer passes ids and nothing else: the line description, the amount and the
 * claim that marks the entry invoiced are all built in SQL inside the same
 * transaction, so an entry cannot be re-priced here and cannot end up on two
 * invoices.
 */
describe('create_invoice from engagement entries', () => {
  it('passes the entry ids to the RPC and prices nothing itself', async () => {
    const { tools, svc } = setup()
    const result = body(
      await tools.get('create_invoice')!.handler({
        client_name: 'Globex',
        request_id: '10000000-0000-4000-8000-000000000001',
        engagement_entry_ids: ['ent1', 'ent2'],
      })
    )

    const call = rpcCalls(svc, 'create_invoice_document')[0]
    expect(call.payload).toMatchObject({ p_engagement_entry_ids: ['ent1', 'ent2'] })
    // No written out lines at all: the schedule supplies them.
    expect((call.payload as { p_lines: unknown[] }).p_lines).toEqual([])
    expect(result.billed_engagement_entry_ids).toEqual(['ent1', 'ent2'])
    expect(result.summary).toContain('cannot be billed again')
  })

  it('sends an empty list when no entries were asked for', async () => {
    const { tools, svc } = setup()
    const result = body(
      await tools.get('create_invoice')!.handler({
        client_name: 'Globex',
        request_id: '10000000-0000-4000-8000-000000000001',
        line_items: [{ description: 'Work', quantity: 1, rate: 10 }],
      })
    )
    expect(rpcCalls(svc, 'create_invoice_document')[0].payload).toMatchObject({
      p_engagement_entry_ids: [],
    })
    expect(result.summary).not.toContain('cannot be billed again')
  })

  it('relays a double billing refusal as something a caller can act on', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tools, svc } = setup({
      'rpc.create_invoice_document': {
        data: null,
        error: { message: 'engagement_entry_already_invoiced' },
      },
    })
    const result = await tools.get('create_invoice')!.handler({
      client_name: 'Globex',
      request_id: '10000000-0000-4000-8000-000000000001',
      engagement_entry_ids: ['ent1'],
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('already on an invoice')
    expect(svc.calls.some((c) => c.table === 'invoices' && c.op === 'insert')).toBe(false)
  })

  it('explains an entry that is not billable yet', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tools } = setup({
      'rpc.create_invoice_document': {
        data: null,
        error: { message: 'engagement_entry_not_ready' },
      },
    })
    const result = await tools.get('create_invoice')!.handler({
      client_name: 'Globex',
      request_id: '10000000-0000-4000-8000-000000000001',
      engagement_entry_ids: ['ent1'],
    })
    expect(result.content[0].text).toContain('not ready to bill yet')
  })

  it('explains a currency mismatch rather than converting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tools } = setup({
      'rpc.create_invoice_document': {
        data: null,
        error: { message: 'engagement_entry_currency_mismatch' },
      },
    })
    const result = await tools.get('create_invoice')!.handler({
      client_name: 'Globex',
      request_id: '10000000-0000-4000-8000-000000000001',
      currency: 'EUR',
      engagement_entry_ids: ['ent1'],
    })
    expect(result.content[0].text).toContain('never converts money')
  })
})

/**
 * update_draft_invoice now routes through replace_invoice_line_items
 * instead of deleting the stored rows, inserting the new
 * ones, and attempting to re-insert the deleted rows if that failed. When the
 * restore itself failed, the invoice was left showing a total with nothing
 * under it and the tool asked the caller to repair the document by hand.
 */
describe('update_draft_invoice', () => {
  it('replaces the line items and the totals in a single transaction', async () => {
    const { tools, svc } = setup()
    const result = await tools.get('update_draft_invoice')!.handler({
      invoice_id: 'inv1',
      line_items: [{ description: 'Rework', quantity: 2, rate: 125 }],
    })

    const calls = rpcCalls(svc, 'replace_invoice_line_items')
    expect(calls).toHaveLength(1)
    const args = calls[0].payload as Record<string, never>
    expect(args.p_invoice_id).toBe('inv1')
    expect(args.p_line_items).toEqual([{ description: 'Rework', quantity: 2, rate: 125, amount: 250 }])
    expect((args.p_invoice_patch as { total: number }).total).toBe(250)

    // balance_due is never sent: the RPC derives it as total - amount_paid, so
    // editing an invoice cannot erase payments already recorded against it.
    expect(args.p_invoice_patch).not.toHaveProperty('balance_due')

    expect(svc.calls.some((c) => c.table === 'invoice_line_items' && c.op === 'delete')).toBe(false)
    expect(svc.calls.some((c) => c.table === 'invoice_line_items' && c.op === 'insert')).toBe(false)
    expect(body(result).invoice.total).toBe(250)
  })

  it('leaves the stored lines untouched when only the header fields change', async () => {
    const { tools, svc } = setup()
    await tools.get('update_draft_invoice')!.handler({ invoice_id: 'inv1', notes: 'Revised' })

    expect(rpcCalls(svc, 'replace_invoice_line_items')).toHaveLength(0)
    const patch = payloadOf(svc, 'invoices', 'update')!
    expect(patch.notes).toBe('Revised')
    // Recomputed from the stored line, unchanged.
    expect(patch.total).toBe(100)
  })

  it('refuses an invoice that is no longer a draft', async () => {
    const { tools, svc } = setup({
      'invoices.select': { data: { ...DRAFT_INVOICE, status: 'sent' }, error: null },
    })
    const result = await tools.get('update_draft_invoice')!.handler({
      invoice_id: 'inv1',
      line_items: [{ description: 'Rework', quantity: 1, rate: 10 }],
    })

    expect(result.isError).toBe(true)
    expect(rpcCalls(svc, 'replace_invoice_line_items')).toHaveLength(0)
  })

  it('refuses an invoice belonging to another business, via ScopedDb', async () => {
    const { tools, svc } = setup({
      'invoices.select': { data: { ...DRAFT_INVOICE, business_id: 'bX' }, error: null },
    })
    const result = await tools.get('update_draft_invoice')!.handler({
      invoice_id: 'inv1',
      line_items: [{ description: 'Rework', quantity: 1, rate: 10 }],
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Invoice not found')
    expect(rpcCalls(svc, 'replace_invoice_line_items')).toHaveLength(0)
  })

  it('never reports an invoice left with no line items, because that is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tools } = setup({
      'rpc.replace_invoice_line_items': { data: null, error: { message: 'deadlock detected' } },
    })
    const result = await tools.get('update_draft_invoice')!.handler({
      invoice_id: 'inv1',
      line_items: [{ description: 'Rework', quantity: 1, rate: 10 }],
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('left unchanged')
    expect(result.content[0].text).not.toContain('no line items')
  })
})

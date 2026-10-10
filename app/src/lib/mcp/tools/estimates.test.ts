import { describe, it, expect, vi, beforeEach } from 'vitest'
import { addDays } from 'date-fns'
import { parseDay, toISODate } from '@/lib/dates'
import type { McpServer } from '@modelcontextprotocol/server'
import { createFakeSupabase, type FakeQuery, type FakeHandler, type FakeResult } from '@/lib/mcp/fake-supabase'
import { createScopedDb } from '@/lib/mcp/scoped-db'
import { registerEstimateTools } from './estimates'
import type { McpCtx } from '@/lib/mcp/context'

interface Registered {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => Promise<{ content: { text: string }[]; isError?: true }>
  description: string
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

const ESTIMATE = {
  id: 'e1',
  business_id: 'b1',
  client_id: 'c1',
  estimate_number: 'EST-0007',
  status: 'accepted',
  public_id: 'estpub',
  currency: 'USD',
  issue_date: '2026-08-01',
  expiry_date: '2026-08-31',
  subtotal: 0.02,
  discount_type: 'percentage',
  discount_value: 0,
  discount_amount: 0,
  tax_rate: 0,
  tax_amount: 0,
  shipping_amount: 0,
  total: 0.02,
  notes: 'Phase one only',
  terms: 'Net 14',
  converted_invoice_id: null,
}

// Three half-cent lines: each rounds up to 0.01 on its own, so summing the
// rounded lines gives 0.03 while the correct round-once subtotal is 0.02.
const ESTIMATE_LINES = [
  { description: 'Half cent A', quantity: 1, rate: 0.005, sort_order: 0 },
  { description: 'Half cent B', quantity: 1, rate: 0.005, sort_order: 1 },
  { description: 'Half cent C', quantity: 1, rate: 0.005, sort_order: 2 },
]

function setup(overrides: Record<string, FakeHandler | FakeResult> = {}) {
  const svc = createFakeSupabase({
    'estimates.select': { data: ESTIMATE, error: null },
    'estimates.update': { data: null, error: null },
    'estimate_line_items.select': { data: ESTIMATE_LINES, error: null },
    'businesses.select': { data: BUSINESS, error: null },
    'businesses.update': { data: null, error: null },
    // allocate_document_number is the atomic replacement for
    // reading businesses.next_*_number and writing back read + 1. It hands back
    // the number it claimed together with the business prefix.
    'rpc.create_estimate_document': {data: {...ESTIMATE, id: 'e9', public_id: 'pub9', estimate_number: 'EST-0007', status: 'draft', subtotal:450,total:450},error:null},
    'rpc.allocate_document_number': (query) => {
      const kind = (query.payload as { p_kind: string }).p_kind
      return kind === 'estimate'
        ? { data: { doc_number: BUSINESS.next_estimate_number, doc_prefix: BUSINESS.estimate_prefix }, error: null }
        : { data: { doc_number: BUSINESS.next_invoice_number, doc_prefix: BUSINESS.invoice_prefix }, error: null }
    },
    // assertClientAccess ends in maybeSingle (a row); resolveClient's
    // name lookup is an ilike returning a list.
    'clients.select': (query) =>
      query.filters.some((f) => f.method === 'ilike')
        ? { data: [CLIENT], error: null }
        : { data: CLIENT, error: null },
    'invoices.insert': (query) => ({
      data: { ...(query.payload as object), id: 'inv1', public_id: 'invpub' },
      error: null,
    }),
    'invoice_line_items.insert': { data: null, error: null },
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
      tools.set(name, { inputSchema: def.inputSchema, handler: handler as Registered['handler'], description: def.description })
    },
  } as unknown as McpServer

  registerEstimateTools(server, ctx)

  return { svc, tools, ctx }
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

describe('estimate tool surface', () => {
  it('registers exactly the six estimate tools', () => {
    const { tools } = setup()
    expect([...tools.keys()].sort()).toEqual([
      'convert_estimate_to_invoice',
      'create_estimate',
      'get_estimate',
      'list_estimates',
      'send_estimate',
      'update_draft_estimate',
    ])
  })

  it('tells the agent when NOT to use each tool', () => {
    const { tools } = setup()
    for (const [name, tool] of tools) {
      expect(tool.description.length, `${name} needs a real description`).toBeGreaterThan(80)
      expect(/not|Refuses|refuses|instead|NOT/.test(tool.description), `${name} needs a when-not-to-use note`).toBe(
        true
      )
    }
  })

  it('uses no em-dashes in tool descriptions', () => {
    const { tools } = setup()
    for (const [name, tool] of tools) {
      expect(tool.description, `${name}`).not.toContain('\u2014')
    }
  })

  it('describes every input field, since that text is what the agent reads', () => {
    const { tools } = setup()
    for (const [name, tool] of tools) {
      for (const [field, schema] of Object.entries(tool.inputSchema.shape)) {
        expect((schema as { description?: string }).description, `${name}.${field}`).toBeTruthy()
      }
    }
  })
})

/**
 * Stateful stand-in for the convert_estimate_to_invoice RPC.
 *
 * It models the one property the RPC exists to provide: the conditional
 * claim succeeds for exactly ONE caller, and every caller after that is told
 * the estimate is already converted and handed the invoice that does exist.
 * `conversions` counts how many invoices were actually created, which is the
 * number the replay test asserts on.
 */
function conversionRpc(overrides: Partial<Record<string, unknown>> = {}) {
  const state = { conversions: 0, invoice: null as Record<string, unknown> | null }

  const handler: FakeHandler = (query) => {
    const args = query.payload as Record<string, unknown>
    if (state.invoice) {
      // Lost the claim. Nothing is written; the winner's invoice comes back.
      return {
        data: { claimed: false, invoice: state.invoice, invoice_number: state.invoice.invoice_number },
        error: null,
      }
    }
    state.conversions += 1
    state.invoice = {
      id: 'inv1',
      public_id: 'invpub',
      business_id: 'b1',
      client_id: 'c1',
      invoice_number: 'INV-0042',
      status: 'draft',
      issue_date: args.p_issue_date,
      due_date: args.p_due_date,
      currency: 'USD',
      subtotal: args.p_subtotal,
      total: args.p_total,
      balance_due: args.p_total,
      ...overrides,
    }
    return {
      data: { claimed: true, invoice: state.invoice, invoice_number: state.invoice.invoice_number },
      error: null,
    }
  }

  return { state, handler }
}

function convertSetup(overrides: Record<string, FakeHandler | FakeResult> = {}) {
  const rpc = conversionRpc()
  const harness = setup({ 'rpc.convert_estimate_to_invoice': rpc.handler, ...overrides })
  return { ...harness, rpc }
}

function rpcCalls(svc: { calls: FakeQuery[] }, fn: string) {
  return svc.calls.filter((c) => c.op === 'rpc' && c.table === fn)
}

describe('convert_estimate_to_invoice', () => {
  it('preserves the quoted total when converting legacy estimates', async () => {
    const { tools, svc } = convertSetup()
    const result = await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' })

    const args = rpcCalls(svc, 'convert_estimate_to_invoice')[0].payload as Record<string, unknown>
    expect(args.p_subtotal).toBe(0.02)
    expect(args.p_total).toBe(0.02)
    // Three half-cent lines: each rounds to 0.01, but the subtotal is rounded
    // once from the raw 0.015 sum, so it is 0.02 and not 0.03.
    expect((args.p_line_items as { amount: number }[]).map((l) => l.amount)).toEqual([0.01, 0.01, 0.01])
    expect(body(result).invoice.total).toBe(0.02)
    expect(body(result).invoice.balance_due).toBe(0.02)
  })

  it('does the claim, the invoice, and the line items in one call rather than three writes', async () => {
    const { tools, svc } = convertSetup()
    await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' })

    expect(rpcCalls(svc, 'convert_estimate_to_invoice')).toHaveLength(1)
    // The old flow inserted the invoice, inserted its line items, then updated
    // the estimate, with no lock and no conditional write between them.
    expect(svc.calls.some((c) => c.table === 'invoices' && c.op === 'insert')).toBe(false)
    expect(svc.calls.some((c) => c.table === 'invoice_line_items' && c.op === 'insert')).toBe(false)
    expect(svc.calls.some((c) => c.table === 'estimates' && c.op === 'update')).toBe(false)
    // And the invoice number is allocated inside the same transaction, not by
    // a separate read-then-write of businesses.next_invoice_number.
    expect(svc.calls.some((c) => c.table === 'businesses' && c.op === 'update')).toBe(false)
  })

  it('carries the estimate line items and agent provenance into the RPC', async () => {
    const { tools, svc } = convertSetup()
    await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' })

    const args = rpcCalls(svc, 'convert_estimate_to_invoice')[0].payload as Record<string, unknown>
    expect(args.p_estimate_id).toBe('e1')
    expect(args.p_created_via).toBe('agent')
    expect(args.p_created_by_key_id).toBe('key1')
    expect(typeof args.p_public_id).toBe('string')
    expect((args.p_public_id as string).length).toBeGreaterThan(0)
  })

  it('defaults the due date to the business payment terms', async () => {
    const { tools, svc } = convertSetup()
    await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1', issue_date: '2026-09-01' })

    const args = rpcCalls(svc, 'convert_estimate_to_invoice')[0].payload as Record<string, unknown>
    expect(args.p_issue_date).toBe('2026-09-01')
    // Same expression create_invoice uses, so conversion and direct creation
    // cannot drift apart on date handling. Note this used to read
    // `format(addDays(new Date('2026-09-01'), 14), 'yyyy-MM-dd')`, which parses
    // the string as UTC midnight and therefore expected 2026-09-14 in any
    // negative-offset zone. Sep 1 plus 14 days is Sep 15. See src/lib/dates.ts.
    expect(args.p_due_date).toBe('2026-09-15')
    expect(args.p_due_date).toBe(toISODate(addDays(parseDay('2026-09-01'), 14)))
  })

  it('refuses an estimate belonging to another business, via ScopedDb', async () => {
    const { tools, svc } = convertSetup({
      'estimates.select': { data: { ...ESTIMATE, business_id: 'bX' }, error: null },
    })
    const result = await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Estimate not found')
    expect(rpcCalls(svc, 'convert_estimate_to_invoice')).toHaveLength(0)
  })

  it('refuses a declined estimate before it reaches the claim', async () => {
    const { tools, svc } = convertSetup({
      'estimates.select': { data: { ...ESTIMATE, status: 'declined' }, error: null },
    })
    const result = await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('declined')
    expect(rpcCalls(svc, 'convert_estimate_to_invoice')).toHaveLength(0)
  })

  it('refuses an estimate with no line items rather than billing zero', async () => {
    const { tools, svc } = convertSetup({ 'estimate_line_items.select': { data: [], error: null } })
    const result = await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('nothing to invoice')
    expect(rpcCalls(svc, 'convert_estimate_to_invoice')).toHaveLength(0)
  })

  it('flags in the summary when the estimate was never formally accepted', async () => {
    const { tools } = convertSetup({ 'estimates.select': { data: { ...ESTIMATE, status: 'sent' }, error: null } })
    const result = await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' })
    expect(body(result).summary).toContain('not formally accepted')
  })

  it('creates nothing and says so when the RPC fails outright', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tools } = convertSetup({
      'rpc.convert_estimate_to_invoice': { data: null, error: { message: 'deadlock detected' } },
    })
    const result = await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' })

    expect(result.isError).toBe(true)
    // The whole conversion is one transaction now, so there is no half-written
    // state left to warn the caller about.
    expect(result.content[0].text).toContain('nothing was created')
  })
})

describe('convert_estimate_to_invoice is replay safe', () => {
  it('creates exactly one invoice when the same estimate is converted twice at once', async () => {
    const rpc = conversionRpc()
    const { tools, svc } = setup({
      'rpc.convert_estimate_to_invoice': rpc.handler,
      'invoice_line_items.select': {
        data: [{ description: 'Half cent A', quantity: 1, rate: 0.005, amount: 0.01, sort_order: 0 }],
        error: null,
      },
    })

    // Both calls read the estimate before either has written anything, which is
    // exactly the interleaving the old read-then-write guard could not survive:
    // both passed the "not converted yet" check and both created an invoice.
    const [first, second] = await Promise.all([
      tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' }),
      tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' }),
    ])

    // ONE invoice, and therefore one invoice number consumed.
    expect(rpc.state.conversions).toBe(1)
    expect(rpcCalls(svc, 'convert_estimate_to_invoice')).toHaveLength(2)

    // Neither call reports failure: the loser converges on the winner's result.
    expect(first.isError).toBeUndefined()
    expect(second.isError).toBeUndefined()

    const bodies = [body(first), body(second)]
    expect(bodies.filter((b) => b.already_converted === false)).toHaveLength(1)
    expect(bodies.filter((b) => b.already_converted === true)).toHaveLength(1)

    // Both point at the same invoice, so a retrying agent cannot end up
    // believing two invoices exist.
    expect(bodies.map((b) => b.invoice.id)).toEqual(['inv1', 'inv1'])
    expect(bodies.map((b) => b.invoice.invoice_number)).toEqual(['INV-0042', 'INV-0042'])
    expect(bodies.map((b) => b.estimate.converted_invoice_id)).toEqual(['inv1', 'inv1'])

    const loser = bodies.find((b) => b.already_converted)!
    expect(loser.summary).toContain('no second invoice exists')
  })

  it('returns the existing invoice, not an error, when the estimate was already converted', async () => {
    const { tools, svc } = setup({
      'estimates.select': { data: { ...ESTIMATE, status: 'converted', converted_invoice_id: 'inv0' }, error: null },
      // assertInvoiceAccess reads the linked invoice.
      'invoices.select': {
        data: {
          id: 'inv0',
          public_id: 'invpub0',
          business_id: 'b1',
          client_id: 'c1',
          invoice_number: 'INV-0041',
          status: 'draft',
          issue_date: '2026-08-02',
          due_date: '2026-08-16',
          currency: 'USD',
          subtotal: 0.02,
          total: 0.02,
          balance_due: 0.02,
        },
        error: null,
      },
      'invoice_line_items.select': {
        data: [{ description: 'Half cent A', quantity: 1, rate: 0.005, amount: 0.01, sort_order: 0 }],
        error: null,
      },
    })

    const result = await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' })
    const json = body(result)

    expect(result.isError).toBeUndefined()
    expect(json.already_converted).toBe(true)
    expect(json.invoice.id).toBe('inv0')
    expect(json.invoice.invoice_number).toBe('INV-0041')
    expect(json.invoice.line_items).toHaveLength(1)
    // Critically: no second conversion was even attempted.
    expect(rpcCalls(svc, 'convert_estimate_to_invoice')).toHaveLength(0)
  })

  it('refuses rather than guessing when the converted link points nowhere reachable', async () => {
    const { tools, svc } = setup({
      'estimates.select': { data: { ...ESTIMATE, status: 'converted', converted_invoice_id: 'inv0' }, error: null },
      'invoices.select': { data: null, error: null },
    })
    const result = await tools.get('convert_estimate_to_invoice')!.handler({ estimate_id: 'e1' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('inv0')
    expect(rpcCalls(svc, 'convert_estimate_to_invoice')).toHaveLength(0)
  })
})

describe('create_estimate', () => {
  it('prices a line from the saved item catalog and stamps provenance', async () => {
    const { tools, svc } = setup({
      'items.select': {
        data: [
          {
            id: 'i1',
            business_id: 'b1',
            name: 'Consulting',
            description: 'Consulting services',
            rate: 150,
            unit: 'hour',
            tax_rate: 0,
            type: 'service',
            is_active: true,
          },
        ],
        error: null,
      },
      'estimates.insert': (query) => ({
        data: { ...(query.payload as object), id: 'e9', public_id: 'pub9' },
        error: null,
      }),
      'estimate_line_items.insert': { data: null, error: null },
    })

    const result = await tools.get('create_estimate')!.handler({
      client_name: 'Globex',
      line_items: [{ item_name: 'Consulting', quantity: 3 }],
    })

    const created = rpcCalls(svc, 'create_estimate_document')
    expect(created).toHaveLength(1)
    expect(created[0].payload).toMatchObject({p_business_id:'b1',p_client_id:'c1',p_key_id:'key1',p_lines:[{description:'Consulting services',quantity:3,rate:150}]})
    expect(body(result).estimate.line_items[0]).toEqual({
      description: 'Consulting services',
      quantity: 3,
      rate: 150,
      amount: 450,
    })
  })

  it('claims the estimate number through allocate_document_number, not a read-then-write', async () => {
    const { tools, svc } = setup({
      'estimates.insert': (query) => ({
        data: { ...(query.payload as object), id: 'e9', public_id: 'pub9' },
        error: null,
      }),
    })

    await tools.get('create_estimate')!.handler({
      client_name: 'Globex',
      line_items: [{ description: 'Work', quantity: 1, rate: 10 }],
    })

    const allocations = rpcCalls(svc, 'create_estimate_document')
    expect(allocations).toHaveLength(1)
    expect(allocations[0].payload).toMatchObject({ p_business_id: 'b1', p_client_id: 'c1' })
    // The old code wrote businesses.next_estimate_number = read + 1 by hand,
    // which two concurrent creates could both compute from the same read.
    expect(svc.calls.some((c) => c.table === 'businesses' && c.op === 'update')).toBe(false)
  })

  it('fails without writing an estimate when no number can be allocated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tools, svc } = setup({
      'rpc.create_estimate_document': { data: null, error: { message: 'forbidden' } },
    })

    const result = await tools.get('create_estimate')!.handler({
      client_name: 'Globex',
      line_items: [{ description: 'Work', quantity: 1, rate: 10 }],
    })

    expect(result.isError).toBe(true)
    expect(svc.calls.some((c) => c.table === 'estimates' && c.op === 'insert')).toBe(false)
  })
})

/**
 * update_draft_estimate now routes through replace_estimate_line_items
 * instead of deleting the old rows and inserting the new ones
 * as two unrelated round trips with a hand-rolled restore in between. That
 * restore could itself fail, and when it did the tool had to tell the caller
 * the estimate now had no line items at all.
 */
describe('update_draft_estimate', () => {
  const DRAFT = { ...ESTIMATE, status: 'draft' }

  function updateSetup(overrides: Record<string, FakeHandler | FakeResult> = {}) {
    return setup({
      'estimates.select': { data: DRAFT, error: null },
      'rpc.replace_estimate_line_items': (query) => ({
        data: { ...DRAFT, ...((query.payload as { p_estimate_patch: object }).p_estimate_patch ?? {}) },
        error: null,
      }),
      ...overrides,
    })
  }

  it('replaces the line items and the totals in a single transaction', async () => {
    const { tools, svc } = updateSetup()
    const result = await tools.get('update_draft_estimate')!.handler({
      estimate_id: 'e1',
      line_items: [{ description: 'Rework', quantity: 2, rate: 125 }],
    })

    const calls = rpcCalls(svc, 'replace_estimate_line_items')
    expect(calls).toHaveLength(1)
    const args = calls[0].payload as Record<string, never>
    expect(args.p_estimate_id).toBe('e1')
    expect(args.p_line_items).toEqual([{ description: 'Rework', quantity: 2, rate: 125, amount: 250 }])
    expect((args.p_estimate_patch as { total: number }).total).toBe(250)
    expect((args.p_estimate_patch as { subtotal: number }).subtotal).toBe(250)

    // The delete-then-insert pair, and the window between them, is gone.
    expect(svc.calls.some((c) => c.table === 'estimate_line_items' && c.op === 'delete')).toBe(false)
    expect(svc.calls.some((c) => c.table === 'estimate_line_items' && c.op === 'insert')).toBe(false)
    expect(body(result).estimate.total).toBe(250)
  })

  it('leaves the stored lines untouched when only the header fields change', async () => {
    const { tools, svc } = updateSetup({
      'estimates.update': (query) => ({ data: { ...DRAFT, ...(query.payload as object) }, error: null }),
    })
    await tools.get('update_draft_estimate')!.handler({ estimate_id: 'e1', notes: 'Revised scope' })

    // No replacement, so no reason to rewrite the lines: a plain UPDATE is
    // already atomic on its own.
    expect(rpcCalls(svc, 'replace_estimate_line_items')).toHaveLength(0)
    const patch = payloadOf(svc, 'estimates', 'update')!
    expect(patch.notes).toBe('Revised scope')
    // Recomputed from the stored half-cent lines, still rounded once.
    expect(patch.total).toBe(0.03)
  })

  it('refuses an estimate that is no longer a draft', async () => {
    const { tools, svc } = updateSetup({ 'estimates.select': { data: ESTIMATE, error: null } })
    const result = await tools.get('update_draft_estimate')!.handler({
      estimate_id: 'e1',
      line_items: [{ description: 'Rework', quantity: 1, rate: 10 }],
    })

    expect(result.isError).toBe(true)
    expect(rpcCalls(svc, 'replace_estimate_line_items')).toHaveLength(0)
  })

  it('never reports an estimate left with no line items, because that is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tools } = updateSetup({
      'rpc.replace_estimate_line_items': { data: null, error: { message: 'deadlock detected' } },
    })
    const result = await tools.get('update_draft_estimate')!.handler({
      estimate_id: 'e1',
      line_items: [{ description: 'Rework', quantity: 1, rate: 10 }],
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('left unchanged')
    expect(result.content[0].text).not.toContain('no line items')
  })
})

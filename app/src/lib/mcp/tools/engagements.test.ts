import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import { createFakeSupabase, type FakeHandler, type FakeResult } from '@/lib/mcp/fake-supabase'
import { createScopedDb } from '@/lib/mcp/scoped-db'
import { registerEngagementTools } from './engagements'
import type { McpCtx } from '@/lib/mcp/context'

interface Registered {
  definition: { title: string; description: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => Promise<{ content: { text: string }[]; isError?: true }>
}

const SUMMARY = {
  engagement_id: 'eng1',
  business_id: 'b1',
  client_id: 'c1',
  name: 'Website rebuild',
  status: 'active',
  billing_mode: 'percent_split',
  currency: 'USD',
  total: 12000,
  starts_on: '2026-09-01',
  target_end: '2026-12-01',
  entry_count: 2,
  amount_billed: 6000,
  amount_waived: 0,
  amount_remaining: 6000,
  ready_count: 1,
  ready_amount: 6000,
  next_ready_entries: [],
}

const ENTRIES = [
  {
    id: 'ent1',
    engagement_id: 'eng1',
    position: 0,
    label: 'Deposit',
    amount: 6000,
    percent: 50,
    due_rule: 'on_start',
    due_on: null,
    status: 'invoiced',
    invoice_id: 'inv1',
    completed_at: null,
    waived_reason: null,
  },
  {
    id: 'ent2',
    engagement_id: 'eng1',
    position: 1,
    label: 'On completion',
    amount: 6000,
    percent: 50,
    due_rule: 'on_complete',
    due_on: null,
    status: 'ready_to_bill',
    invoice_id: null,
    completed_at: null,
    waived_reason: null,
  },
]

const PAYLOAD = {
  engagement: {
    id: 'eng1',
    business_id: 'b1',
    client_id: 'c1',
    name: 'Website rebuild',
    total: 12000,
    currency: 'USD',
    status: 'active',
    billing_mode: 'percent_split',
    starts_on: null,
    target_end: null,
    notes: null,
  },
  summary: { amount_billed: 6000, amount_remaining: 6000, ready_count: 1 },
  entries: ENTRIES,
  replayed: false,
}

/**
 * list_engagements reads the summary view as a list, get_engagement reads one
 * row out of it. Both land on the same fake key, so the shape is chosen the
 * way PostgREST chooses it: by whether the query pinned a single engagement.
 */
const summaryHandler: FakeHandler = (query) =>
  query.filters.some((f) => f.method === 'eq' && f.args[0] === 'engagement_id')
    ? { data: SUMMARY, error: null }
    : { data: [SUMMARY], error: null }

function setup(overrides: Record<string, FakeHandler | FakeResult> = {}) {
  const svc = createFakeSupabase({
    'rpc.promote_due_entries': { data: { promoted: 0, entry_ids: [] }, error: null },
    'engagement_summary.select': summaryHandler,
    'engagement_entries.select': { data: ENTRIES, error: null },
    'clients.select': { data: [{ id: 'c1', name: 'Harbor and Lane' }], error: null },
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
    registerTool: (name: string, definition: unknown, handler: unknown) => {
      tools.set(name, {
        definition: definition as Registered['definition'],
        handler: handler as Registered['handler'],
      })
    },
  } as unknown as McpServer

  registerEngagementTools(server, ctx)
  return { svc, tools }
}

function body(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

function rpcCalls(svc: { calls: { op: string; table: string; payload?: unknown }[] }, fn: string) {
  return svc.calls.filter((call) => call.op === 'rpc' && call.table === fn)
}

function filterArgs(svc: { calls: { table: string; filters: { method: string; args: unknown[] }[] }[] }, table: string) {
  return svc.calls.filter((call) => call.table === table).flatMap((call) => call.filters)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('engagement tools', () => {
  it('registers exactly the engagement surface', () => {
    const { tools } = setup()
    expect([...tools.keys()].sort()).toEqual([
      'complete_engagement',
      'convert_estimate_to_engagement',
      'create_engagement',
      'get_engagement',
      'list_engagements',
      'list_ready_to_bill',
      'mark_milestone_complete',
      'update_engagement',
      'waive_engagement_entry',
    ])
  })

  it('promises in every description that engagements never send anything', () => {
    const { tools } = setup()
    for (const [name, tool] of tools) {
      expect(tool.definition.description.toLowerCase(), `${name} must say it sends nothing`).toMatch(
        /sent|send/
      )
    }
  })
})

describe('list_engagements', () => {
  it('sweeps dated entries before answering, so a read is never stale', async () => {
    const { svc, tools } = setup()
    await tools.get('list_engagements')!.handler({})
    expect(rpcCalls(svc, 'promote_due_entries')).toHaveLength(1)
    expect(rpcCalls(svc, 'promote_due_entries')[0].payload).toMatchObject({
      p_business_id: 'b1',
      p_actor_key_id: 'key1',
    })
  })

  it('reports billed and remaining money from the summary view', async () => {
    const { tools } = setup()
    const result = body(await tools.get('list_engagements')!.handler({}))
    expect(result.engagements[0]).toMatchObject({
      id: 'eng1',
      client_name: 'Harbor and Lane',
      total: 12000,
      amount_billed: 6000,
      amount_remaining: 6000,
      ready_count: 1,
    })
    expect(result.summary).toContain('1 engagement')
  })

  it('applies the client, status and ready to bill filters', async () => {
    const { svc, tools } = setup()
    await tools.get('list_engagements')!.handler({
      client_id: 'c1',
      status: 'active',
      has_ready_to_bill: true,
    })
    const filters = filterArgs(svc, 'engagement_summary')
    expect(filters).toContainEqual({ method: 'eq', args: ['client_id', 'c1'] })
    expect(filters).toContainEqual({ method: 'eq', args: ['status', 'active'] })
    expect(filters).toContainEqual({ method: 'gt', args: ['ready_count', 0] })
  })

  it('pages with an offset and reports the next one only when the page was full', async () => {
    const { tools } = setup()
    const short = body(await tools.get('list_engagements')!.handler({ offset: 0, limit: 5 }))
    expect(short.next_offset).toBeNull()

    const { tools: fullTools } = setup({
      'engagement_summary.select': { data: [SUMMARY, SUMMARY], error: null },
    })
    const full = body(await fullTools.get('list_engagements')!.handler({ limit: 2 }))
    expect(full.next_offset).toBe(2)
  })

  it('refuses a business outside the key scope', async () => {
    const { tools } = setup()
    const result = await tools.get('list_engagements')!.handler({ business_id: 'b2' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('do not have access')
  })
})

describe('get_engagement', () => {
  it('returns the whole schedule with a link to each billed invoice', async () => {
    const { tools } = setup()
    const result = body(await tools.get('get_engagement')!.handler({ engagement_id: 'eng1' }))
    expect(result.schedule).toHaveLength(2)
    expect(result.schedule[0]).toMatchObject({ entry_id: 'ent1', status: 'invoiced' })
    expect(result.schedule[0].invoice_url).toContain('/invoices/inv1')
    expect(result.schedule[1].invoice_url).toBeNull()
    expect(result.engagement.amount_remaining).toBe(6000)
  })

  it('answers a missing engagement and another tenant engagement identically', async () => {
    const missing = setup({ 'engagement_summary.select': { data: null, error: null } })
    const denied = setup({ 'engagement_summary.select': { data: null, error: null } })

    const a = await missing.tools.get('get_engagement')!.handler({ engagement_id: 'eng1' })
    const b = await denied.tools.get('get_engagement')!.handler({ engagement_id: 'other' })

    expect(a.isError).toBe(true)
    expect(a.content[0].text).toBe('Engagement not found')
    expect(b.content[0].text).toBe(a.content[0].text)
  })

  it('scopes the summary lookup to the key businesses', async () => {
    const { svc, tools } = setup()
    await tools.get('get_engagement')!.handler({ engagement_id: 'eng1' })
    expect(filterArgs(svc, 'engagement_summary')).toContainEqual({
      method: 'in',
      args: ['business_id', ['b1']],
    })
  })
})

describe('list_ready_to_bill', () => {
  const READY = [
    {
      id: 'ent2',
      engagement_id: 'eng1',
      business_id: 'b1',
      position: 1,
      label: 'On completion',
      amount: 6000,
      due_rule: 'on_complete',
      due_on: null,
      status: 'ready_to_bill',
      engagement: { name: 'Website rebuild', currency: 'USD', client_id: 'c1', status: 'completed' },
    },
    {
      id: 'ent9',
      engagement_id: 'eng2',
      business_id: 'b1',
      position: 0,
      label: 'Deposit',
      amount: 1000,
      due_rule: 'on_start',
      due_on: null,
      status: 'ready_to_bill',
      engagement: { name: 'Brand refresh', currency: 'USD', client_id: 'c2', status: 'active' },
    },
  ]

  it('lists billable work across clients and totals it', async () => {
    const { tools } = setup({ 'engagement_entries.select': { data: READY, error: null } })
    const result = body(await tools.get('list_ready_to_bill')!.handler({}))
    expect(result.entries).toHaveLength(2)
    expect(result.summary).toContain('$7,000.00')
    expect(result.entries[0].engagement_name).toBe('Website rebuild')
  })

  it('filters to one client without asking the database for the other', async () => {
    const { tools } = setup({ 'engagement_entries.select': { data: READY, error: null } })
    const result = body(await tools.get('list_ready_to_bill')!.handler({ client_id: 'c2' }))
    expect(result.entries.map((entry: { entry_id: string }) => entry.entry_id)).toEqual(['ent9'])
  })

  it('only asks for entries that are ready to bill', async () => {
    const { svc, tools } = setup({ 'engagement_entries.select': { data: READY, error: null } })
    await tools.get('list_ready_to_bill')!.handler({})
    expect(filterArgs(svc, 'engagement_entries')).toContainEqual({
      method: 'eq',
      args: ['status', 'ready_to_bill'],
    })
  })

  it('flags a dated entry whose date has already passed, and reports the date', async () => {
    const DATED = [
      { ...READY[0], id: 'ent7', due_rule: 'on_date', due_on: '2020-01-01' },
      { ...READY[1], id: 'ent8', due_rule: 'on_date', due_on: '2999-01-01' },
    ]
    const { tools } = setup({ 'engagement_entries.select': { data: DATED, error: null } })
    const result = body(await tools.get('list_ready_to_bill')!.handler({}))

    expect(result.entries[0]).toMatchObject({
      entry_id: 'ent7',
      due_on: '2020-01-01',
      overdue_on_date: true,
    })
    expect(result.entries[1]).toMatchObject({ due_on: '2999-01-01', overdue_on_date: false })
    expect(result.overdue_count).toBe(1)
    expect(result.summary).toContain('already passed')
  })

  it('never flags an entry that was not waiting on a date', async () => {
    const { tools } = setup({ 'engagement_entries.select': { data: READY, error: null } })
    const result = body(await tools.get('list_ready_to_bill')!.handler({}))
    expect(result.entries.every((entry: { overdue_on_date: boolean }) => !entry.overdue_on_date)).toBe(
      true
    )
    expect(result.overdue_count).toBe(0)
  })

  it('links each entry to a new invoice already carrying it', async () => {
    const { tools } = setup({ 'engagement_entries.select': { data: READY, error: null } })
    const result = body(await tools.get('list_ready_to_bill')!.handler({}))
    expect(result.entries[0].new_invoice_url).toContain('/invoices/new?engagement_entries=ent2')
  })
})

describe('convert_estimate_to_engagement', () => {
  const CONVERTED = { ...PAYLOAD, estimate: { id: 'est1' } }

  it('sends only the shape of the schedule, never the total or the currency', async () => {
    const { svc, tools } = setup({
      'rpc.convert_estimate_to_engagement': { data: CONVERTED, error: null },
    })
    const result = body(
      await tools.get('convert_estimate_to_engagement')!.handler({
        request_id: '11111111-1111-4111-8111-111111111111',
        estimate_id: '22222222-2222-4222-8222-222222222222',
        billing_mode: 'percent_split',
        entries: [{ label: 'Deposit', percent: 50 }, { label: 'On delivery', percent: 50 }],
      })
    )

    const payload = rpcCalls(svc, 'convert_estimate_to_engagement')[0].payload as Record<string, unknown>
    expect(payload).toMatchObject({
      p_request_id: '11111111-1111-4111-8111-111111111111',
      p_estimate_id: '22222222-2222-4222-8222-222222222222',
      p_billing_mode: 'percent_split',
      p_actor_key_id: 'key1',
    })
    expect(payload).not.toHaveProperty('p_total')
    expect(payload).not.toHaveProperty('p_currency')
    expect(payload).not.toHaveProperty('p_client_id')
    expect(result.summary).toContain('Nothing was sent to the client')
    expect(result.summary).toContain('draft')
  })

  it('refuses a quote that already became an invoice', async () => {
    const { tools } = setup({
      'rpc.convert_estimate_to_engagement': {
        data: null,
        error: { message: 'estimate_already_converted' },
      },
    })
    const result = await tools.get('convert_estimate_to_engagement')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      estimate_id: '22222222-2222-4222-8222-222222222222',
      billing_mode: 'equal_installments',
      installments: 2,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('already been converted into an invoice')
  })

  it('refuses a quote that already became an engagement', async () => {
    const { tools } = setup({
      'rpc.convert_estimate_to_engagement': {
        data: null,
        error: { message: 'estimate_already_an_engagement' },
      },
    })
    const result = await tools.get('convert_estimate_to_engagement')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      estimate_id: '22222222-2222-4222-8222-222222222222',
      billing_mode: 'equal_installments',
      installments: 2,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('already become an engagement')
  })
})

describe('create_engagement', () => {
  const created = { data: PAYLOAD, error: null }

  it('hands the schedule to the database rather than expanding it here', async () => {
    const { svc, tools } = setup({
      'rpc.create_engagement_with_schedule': created,
      'clients.select': { data: { id: 'c1', business_id: 'b1', name: 'Harbor and Lane' }, error: null },
    })

    const result = body(
      await tools.get('create_engagement')!.handler({
        request_id: '11111111-1111-4111-8111-111111111111',
        client_id: 'c1',
        name: 'Website rebuild',
        total: 12000,
        billing_mode: 'percent_split',
        entries: [
          { label: 'Deposit', percent: 50 },
          { label: 'On completion', percent: 50 },
        ],
      })
    )

    const call = rpcCalls(svc, 'create_engagement_with_schedule')[0]
    expect(call.payload).toMatchObject({
      p_request_id: '11111111-1111-4111-8111-111111111111',
      p_business_id: 'b1',
      p_client_id: 'c1',
      p_total: 12000,
      p_billing_mode: 'percent_split',
      p_status: 'draft',
      p_actor_key_id: 'key1',
    })
    expect(result.summary).toContain('Nothing was sent to the client')
    expect(result.schedule).toHaveLength(2)
  })

  it('starts the engagement when asked, which is what fires a deposit', async () => {
    const { svc, tools } = setup({
      'rpc.create_engagement_with_schedule': created,
      'clients.select': { data: { id: 'c1', business_id: 'b1', name: 'Harbor and Lane' }, error: null },
    })
    await tools.get('create_engagement')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      client_id: 'c1',
      name: 'Website rebuild',
      total: 1000,
      billing_mode: 'equal_installments',
      installments: 2,
      start_now: true,
    })
    expect(rpcCalls(svc, 'create_engagement_with_schedule')[0].payload).toMatchObject({
      p_status: 'active',
      p_installments: 2,
    })
  })

  it('relays the schedule rules in words a caller can act on', async () => {
    const { tools } = setup({
      'rpc.create_engagement_with_schedule': { data: null, error: { message: 'percent_must_total_100' } },
      'clients.select': { data: { id: 'c1', business_id: 'b1', name: 'Harbor and Lane' }, error: null },
    })
    const result = await tools.get('create_engagement')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      client_id: 'c1',
      name: 'Website rebuild',
      total: 12000,
      billing_mode: 'percent_split',
      entries: [{ percent: 30 }, { percent: 60 }],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('add up to exactly 100')
  })

  it('explains a key that lacks the write permission', async () => {
    const { tools } = setup({
      'rpc.create_engagement_with_schedule': { data: null, error: { message: 'key_cannot_manage_engagements' } },
      'clients.select': { data: { id: 'c1', business_id: 'b1', name: 'Harbor and Lane' }, error: null },
    })
    const result = await tools.get('create_engagement')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      client_id: 'c1',
      name: 'Website rebuild',
      total: 100,
      billing_mode: 'equal_installments',
      installments: 2,
    })
    expect(result.content[0].text).toContain('write permission')
  })

  it('refuses a client that belongs to another business', async () => {
    const { tools } = setup({
      'clients.select': { data: { id: 'c9', business_id: 'b2', name: 'Other' }, error: null },
    })
    const result = await tools.get('create_engagement')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      client_id: 'c9',
      name: 'Cross tenant',
      total: 100,
      billing_mode: 'equal_installments',
      installments: 2,
    })
    expect(result.isError).toBe(true)
  })
})

describe('update_engagement', () => {
  it('refuses a call with nothing to change', async () => {
    const { svc, tools } = setup()
    const result = await tools.get('update_engagement')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      engagement_id: 'eng1',
    })
    expect(result.isError).toBe(true)
    expect(rpcCalls(svc, 'update_engagement')).toHaveLength(0)
  })

  it('passes only the fields it was given', async () => {
    const { svc, tools } = setup({ 'rpc.update_engagement': { data: PAYLOAD, error: null } })
    await tools.get('update_engagement')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      engagement_id: 'eng1',
      notes: 'Signed on the 1st',
    })
    expect(rpcCalls(svc, 'update_engagement')[0].payload).toMatchObject({
      p_engagement_id: 'eng1',
      p_notes: 'Signed on the 1st',
      p_name: undefined,
    })
  })
})

describe('mark_milestone_complete', () => {
  it('says what became billable', async () => {
    const { tools } = setup({
      'rpc.mark_entry_complete': {
        data: { ...PAYLOAD, became_ready_to_bill: true, entry: { ...ENTRIES[1], status: 'ready_to_bill' } },
        error: null,
      },
    })
    const result = body(
      await tools.get('mark_milestone_complete')!.handler({
        request_id: '11111111-1111-4111-8111-111111111111',
        entry_id: 'ent2',
      })
    )
    expect(result.summary).toContain('$6,000.00 is now ready to bill')
    expect(result.summary).toContain('Nothing was sent')
  })

  it('says when an entry is still waiting on its own rule', async () => {
    const { tools } = setup({
      'rpc.mark_entry_complete': {
        data: { ...PAYLOAD, became_ready_to_bill: false, entry: ENTRIES[1] },
        error: null,
      },
    })
    const result = body(
      await tools.get('mark_milestone_complete')!.handler({
        request_id: '11111111-1111-4111-8111-111111111111',
        entry_id: 'ent2',
      })
    )
    expect(result.summary).toContain('still waiting on its own due rule')
  })

  it('refuses to touch money that has already been invoiced', async () => {
    const { tools } = setup({
      'rpc.mark_entry_complete': { data: null, error: { message: 'entry_already_invoiced' } },
    })
    const result = await tools.get('mark_milestone_complete')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      entry_id: 'ent1',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('already been invoiced')
  })
})

describe('complete_engagement', () => {
  it('reports the money left unbilled rather than swallowing it', async () => {
    const { svc, tools } = setup({
      'rpc.set_engagement_status': {
        data: { ...PAYLOAD, warning: 'unbilled', amount_remaining: 6000 },
        error: null,
      },
    })
    const result = body(
      await tools.get('complete_engagement')!.handler({
        request_id: '11111111-1111-4111-8111-111111111111',
        engagement_id: 'eng1',
      })
    )
    expect(rpcCalls(svc, 'set_engagement_status')[0].payload).toMatchObject({ p_status: 'completed' })
    expect(result.summary).toContain('$6,000.00 of the agreed $12,000.00 is still unbilled')
    expect(result.warning).toBe('unbilled')
  })

  it('refuses to reopen a closed engagement', async () => {
    const { tools } = setup({
      'rpc.set_engagement_status': { data: null, error: { message: 'engagement_closed' } },
    })
    const result = await tools.get('complete_engagement')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      engagement_id: 'eng1',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('already completed or cancelled')
  })
})

describe('waive_engagement_entry', () => {
  it('reports what is left after the write off', async () => {
    const { svc, tools } = setup({
      'rpc.waive_entry': {
        data: { ...PAYLOAD, entry: { ...ENTRIES[1], status: 'waived', waived_reason: 'Dropped' } },
        error: null,
      },
    })
    const result = body(
      await tools.get('waive_engagement_entry')!.handler({
        request_id: '11111111-1111-4111-8111-111111111111',
        entry_id: 'ent2',
        reason: 'Dropped',
      })
    )
    expect(rpcCalls(svc, 'waive_entry')[0].payload).toMatchObject({ p_reason: 'Dropped' })
    expect(result.summary).toContain('Waived $6,000.00')
  })

  it('refuses to waive billed money', async () => {
    const { tools } = setup({
      'rpc.waive_entry': { data: null, error: { message: 'entry_already_invoiced' } },
    })
    const result = await tools.get('waive_engagement_entry')!.handler({
      request_id: '11111111-1111-4111-8111-111111111111',
      entry_id: 'ent1',
      reason: 'Dropped',
    })
    expect(result.isError).toBe(true)
  })
})

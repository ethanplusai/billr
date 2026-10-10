import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import { createFakeSupabase, type FakeHandler, type FakeResult } from '@/lib/mcp/fake-supabase'
import { createScopedDb } from '@/lib/mcp/scoped-db'
import { registerPaymentTools, reconcilePayments } from './payments'
import { registerInvoiceSendTools } from './invoices-send'
import type { McpCtx } from '@/lib/mcp/context'

interface Registered {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => Promise<{ content: { text: string }[]; isError?: true }>
}

const INVOICE = {
  id: 'inv1',
  business_id: 'b1',
  client_id: 'c1',
  public_id: 'pub1',
  invoice_number: 'INV-0042',
  status: 'partial',
  currency: 'USD',
  total: 1000,
  amount_paid: 400,
  balance_due: 600,
  due_date: '2099-01-01',
  paid_at: null,
}

const PAYMENTS = [
  {
    id: 'pay1',
    amount: 250,
    payment_date: '2026-08-01',
    payment_method: 'bank_transfer',
    reference_number: 'REF-1',
    notes: null,
    created_via: 'web',
    stripe_payment_id: null,
    source: 'manual',
    voided_at: null,
    void_reason: null,
  },
  {
    id: 'pay2',
    amount: 150,
    payment_date: '2026-08-10',
    payment_method: 'credit_card',
    reference_number: null,
    notes: null,
    created_via: 'stripe',
    stripe_payment_id: 'pi_123',
    source: 'stripe',
    voided_at: null,
    void_reason: null,
  },
]

const VOIDED_PAYMENT = {
  id: 'pay3',
  amount: 500,
  payment_date: '2026-08-15',
  payment_method: 'check',
  reference_number: 'REF-DUP',
  notes: null,
  created_via: 'web',
  stripe_payment_id: null,
  source: 'manual',
  voided_at: '2026-09-01T10:00:00Z',
  void_reason: 'Recorded twice',
}

function setup(overrides: Record<string, FakeHandler | FakeResult> = {}) {
  const svc = createFakeSupabase({
    'invoices.select': { data: INVOICE, error: null },
    'payments.select': { data: PAYMENTS, error: null },
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

  registerPaymentTools(server, ctx)
  // record_payment lives with send_invoice, not with get_payment_status, but it
  // is the write half of the same money path so it is exercised here alongside
  // the read half.
  registerInvoiceSendTools(server, ctx)
  return { svc, tools }
}

function rpcCalls(svc: { calls: { op: string; table: string; payload?: unknown }[] }, fn: string) {
  return svc.calls.filter((c) => c.op === 'rpc' && c.table === fn)
}

function body(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('reconcilePayments', () => {
  it('sums the ledger and agrees with a matching stored amount_paid', () => {
    expect(reconcilePayments([{ amount: 250 }, { amount: 150 }], 400)).toEqual({
      ledger_total: 400,
      recorded_amount_paid: 400,
      mismatch: false,
    })
  })

  it('flags a ledger that disagrees with the invoice', () => {
    expect(reconcilePayments([{ amount: 250 }], 400).mismatch).toBe(true)
  })

  it('rounds float drift back to cents rather than reporting a false mismatch', () => {
    expect(reconcilePayments([{ amount: 0.1 }, { amount: 0.2 }], 0.3)).toEqual({
      ledger_total: 0.3,
      recorded_amount_paid: 0.3,
      mismatch: false,
    })
  })

  it('treats an empty ledger against a zero balance as consistent', () => {
    expect(reconcilePayments([], 0).mismatch).toBe(false)
  })
})

describe('get_payment_status', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reports amount due, amount paid, and the payment history', async () => {
    const { tools } = setup()
    const result = await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' })
    const json = body(result)

    expect(json.invoice).toMatchObject({ total: 1000, amount_paid: 400, balance_due: 600 })
    expect(json.payments).toHaveLength(2)
    expect(json.payments_count).toBe(2)
    expect(json.reconciliation).toMatchObject({ ledger_total: 400, mismatch: false })
    expect(json.summary).toContain('$400.00 paid')
    expect(json.summary).toContain('$600.00 still due')
  })

  it('reads the payments ledger', async () => {
    const { tools, svc } = setup()
    await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' })

    expect(svc.calls.some((c) => c.table === 'payments')).toBe(true)
  })

  it('scopes the ledger query to the invoice and its business', async () => {
    const { tools, svc } = setup()
    await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' })

    const ledgerQuery = svc.calls.find((c) => c.table === 'payments')!
    expect(ledgerQuery.filters).toContainEqual({ method: 'eq', args: ['invoice_id', 'inv1'] })
    expect(ledgerQuery.filters).toContainEqual({ method: 'eq', args: ['business_id', 'b1'] })
  })

  it('labels a Stripe payment as arriving through the pay link', async () => {
    const { tools } = setup()
    const json = body(await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' }))
    expect(json.payments.map((p: { source: string }) => p.source)).toEqual(['manual', 'stripe'])
  })

  it('returns a stable payment_id per row so a correction can name one', async () => {
    const { tools } = setup()
    const json = body(await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' }))
    expect(json.payments.map((p: { payment_id: string }) => p.payment_id)).toEqual(['pay1', 'pay2'])
  })

  // The bug: a voided payment that still counts is money the user does not
  // have. It must leave the list AND the reconciliation total.
  it('leaves voided payments out of the list and out of every total', async () => {
    const { tools } = setup({
      'payments.select': { data: [...PAYMENTS, VOIDED_PAYMENT], error: null },
    })
    const json = body(await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' }))

    expect(json.payments).toHaveLength(2)
    expect(json.voided_count).toBe(1)
    expect(json.reconciliation.ledger_total).toBe(400)
    expect(json.reconciliation.mismatch).toBe(false)
  })

  it('shows voided payments with their reason when asked, still without counting them', async () => {
    const { tools } = setup({
      'payments.select': { data: [...PAYMENTS, VOIDED_PAYMENT], error: null },
    })
    const json = body(
      await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1', include_voided: true })
    )

    expect(json.payments).toHaveLength(3)
    expect(json.payments[2]).toMatchObject({
      payment_id: 'pay3',
      voided_at: '2026-09-01T10:00:00Z',
      void_reason: 'Recorded twice',
    })
    expect(json.reconciliation.ledger_total).toBe(400)
  })

  it('reports the pay link when online payments are switched on', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example')
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_example')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_example')
    const { tools } = setup()
    const json = body(await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' }))
    expect(json.online_payments_enabled).toBe(true)
    expect(json.pay_url).toContain('/i/pub1')
  })

  it('reports no pay link when card payments are not set up', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', '')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '')
    const { tools } = setup()
    const json = body(await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' }))
    expect(json.online_payments_enabled).toBe(false)
    expect(json.pay_url).toBeNull()
    expect(json.public_url).toContain('/i/pub1')
  })

  it('warns instead of guessing when the ledger and the invoice disagree', async () => {
    const { tools } = setup({ 'payments.select': { data: [{ ...PAYMENTS[0] }], error: null } })
    const json = body(await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' }))

    expect(json.reconciliation.mismatch).toBe(true)
    expect(json.summary).toContain('does not match')
  })

  it('marks a past-due invoice as overdue', async () => {
    const { tools } = setup({
      'invoices.select': { data: { ...INVOICE, status: 'sent', due_date: '2000-01-01' }, error: null },
    })
    const json = body(await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' }))
    expect(json.invoice.is_overdue).toBe(true)
    expect(json.summary).toContain('overdue since 2000-01-01')
  })

  it('refuses an invoice belonging to another business, via ScopedDb', async () => {
    const { tools, svc } = setup({ 'invoices.select': { data: { ...INVOICE, business_id: 'bX' }, error: null } })
    const result = await tools.get('get_payment_status')!.handler({ invoice_id: 'inv1' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Invoice not found')
    expect(svc.calls.some((c) => c.table === 'payments')).toBe(false)
  })
})

/**
 * record_payment goes through the record_invoice_payment RPC,
 * which inserts the ledger row and recomputes the invoice from SUM(payments) in
 * one transaction. These tests exist because that call site had NO coverage at
 * all once it moved to an RPC: the test fake had no .rpc(), so the handler was
 * never reached past the scope check. This is the path that previously shipped
 * two duplicate-record bugs, so it does not get to be untested.
 */
describe('record_payment', () => {
  const RECORDED = {
    payment_id: 'pay1',
    duplicate: false,
    ledger_total: 1000,
    invoice: { status: 'paid', amount_paid: 1000, balance_due: 0 },
  }

  function paymentSetup(overrides: Record<string, FakeHandler | FakeResult> = {}) {
    return setup({ 'rpc.record_payment_once': { data: RECORDED, error: null }, ...overrides })
  }

  it('records the payment in one RPC rather than an insert plus an update', async () => {
    const { tools, svc } = paymentSetup()
    await tools.get('record_payment')!.handler({ invoice_id: 'inv1', amount: 600, payment_date: '2026-08-20' })

    expect(rpcCalls(svc, 'record_payment_once')).toHaveLength(1)
    // A separate ledger insert and a separate invoice update is exactly the
    // shape that let money land without the invoice ever reflecting it.
    expect(svc.calls.some((c) => c.table === 'payments' && c.op === 'insert')).toBe(false)
    expect(svc.calls.some((c) => c.table === 'invoices' && c.op === 'update')).toBe(false)
  })

  it('passes the payment through with agent provenance and the caller key', async () => {
    const { tools, svc } = paymentSetup()
    await tools.get('record_payment')!.handler({
      invoice_id: 'inv1',
      amount: 600,
      payment_date: '2026-08-20',
      method: 'bank_transfer',
      reference_number: 'REF-9',
      notes: 'Wire',
    })

    expect(rpcCalls(svc, 'record_payment_once')[0].payload).toEqual({
      p_invoice_id: 'inv1',
      p_amount: 600,
      p_payment_date: '2026-08-20',
      p_payment_method: 'bank_transfer',
      p_reference_number: 'REF-9',
      p_notes: 'Wire',
      p_created_via: 'agent',
      p_created_by_key_id: 'key1',
    })
  })

  it('defaults the method and the payment date rather than leaving them null', async () => {
    const { tools, svc } = paymentSetup()
    await tools.get('record_payment')!.handler({ invoice_id: 'inv1', amount: 600 })

    const args = rpcCalls(svc, 'record_payment_once')[0].payload as Record<string, unknown>
    expect(args.p_payment_method).toBe('other')
    expect(args.p_payment_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('reports the status and balance the RPC computed, not a locally guessed one', async () => {
    const { tools } = paymentSetup()
    const json = body(await tools.get('record_payment')!.handler({ invoice_id: 'inv1', amount: 600 }))

    expect(json.invoice).toEqual({ status: 'paid', amount_paid: 1000, balance_due: 0 })
    expect(json.summary).toContain('$600.00 payment')
    expect(json.summary).toContain('now paid')
    expect(json.summary).toContain('$0.00 balance due')
  })

  it('reports a partial payment as partial with the remaining balance', async () => {
    const { tools } = paymentSetup({
      'rpc.record_payment_once': {
        data: { ...RECORDED, ledger_total: 700, invoice: { status: 'partial', amount_paid: 700, balance_due: 300 } },
        error: null,
      },
    })
    const json = body(await tools.get('record_payment')!.handler({ invoice_id: 'inv1', amount: 300 }))

    expect(json.invoice.status).toBe('partial')
    expect(json.summary).toContain('$300.00 balance due')
  })

  it('refuses a cancelled invoice without touching the ledger', async () => {
    const { tools, svc } = paymentSetup({
      'invoices.select': { data: { ...INVOICE, status: 'cancelled' }, error: null },
    })
    const result = await tools.get('record_payment')!.handler({ invoice_id: 'inv1', amount: 100 })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('cancelled')
    expect(rpcCalls(svc, 'record_payment_once')).toHaveLength(0)
  })

  it('refuses an invoice belonging to another business, via ScopedDb', async () => {
    const { tools, svc } = paymentSetup({
      'invoices.select': { data: { ...INVOICE, business_id: 'bX' }, error: null },
    })
    const result = await tools.get('record_payment')!.handler({ invoice_id: 'inv1', amount: 100 })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Invoice not found')
    expect(rpcCalls(svc, 'record_payment_once')).toHaveLength(0)
  })

  it('reports a failure instead of claiming money was recorded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tools } = paymentSetup({
      'rpc.record_payment_once': { data: null, error: { message: 'invoice_not_found' } },
    })
    const result = await tools.get('record_payment')!.handler({ invoice_id: 'inv1', amount: 100 })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Could not record payment.')
  })
})

/**
 * update_payment and void_payment. These exist because the
 * ledger was write-once: an agent backfill stamped fourteen already-paid
 * invoices with the date of the backfill, and there was no self-serve way to
 * put the money back in the month it arrived.
 *
 * The rules live in the RPC, so what is asserted here is the contract this
 * layer owes it: scope is established before the call, the caller's key id is
 * passed as the actor, request_id is forwarded untouched, Stripe money is
 * refused with an explanation rather than an error code, and a refusal never
 * reads as success.
 */
describe('payment corrections', () => {
  const MANUAL_PAYMENT = {
    id: 'pay1',
    business_id: 'b1',
    invoice_id: 'inv1',
    amount: 400,
    currency: 'USD',
    payment_date: '2026-09-21',
    payment_method: 'bank_transfer',
    reference_number: null,
    notes: null,
    source: 'manual',
    voided_at: null,
    void_reason: null,
  }

  const UPDATED = {
    payment: { ...MANUAL_PAYMENT, payment_date: '2026-06-15' },
    invoice: { invoice_number: 'INV-0042', status: 'paid', amount_paid: 400, balance_due: 0, currency: 'USD' },
    replayed: false,
  }

  function correctionSetup(overrides: Record<string, FakeHandler | FakeResult> = {}) {
    return setup({
      'payments.select': { data: MANUAL_PAYMENT, error: null },
      'rpc.update_payment': { data: UPDATED, error: null },
      'rpc.void_payment': {
        data: {
          payment: { ...MANUAL_PAYMENT, voided_at: '2026-09-22T00:00:00Z', void_reason: 'Recorded twice' },
          invoice: { invoice_number: 'INV-0042', status: 'sent', amount_paid: 0, balance_due: 1000, currency: 'USD' },
          replayed: false,
        },
        error: null,
      },
      ...overrides,
    })
  }

  it('sends the correction to the RPC with the caller key as the actor', async () => {
    const { tools, svc } = correctionSetup()
    await tools.get('update_payment')!.handler({
      request_id: 'fix-1',
      payment_id: 'pay1',
      payment_date: '2026-06-15',
    })

    expect(rpcCalls(svc, 'update_payment')[0].payload).toEqual({
      p_payment_id: 'pay1',
      p_request_id: 'fix-1',
      p_payment_date: '2026-06-15',
      p_method: undefined,
      p_notes: undefined,
      p_reference_number: undefined,
      p_amount: undefined,
      p_actor_key_id: 'key1',
    })
    // The correction is one transactional RPC, never a direct row write.
    expect(svc.calls.some((c) => c.table === 'payments' && c.op === 'update')).toBe(false)
    expect(svc.calls.some((c) => c.table === 'invoices' && c.op === 'update')).toBe(false)
  })

  it('reports the status and balance the RPC recomputed', async () => {
    const { tools } = correctionSetup({
      'rpc.update_payment': {
        data: {
          ...UPDATED,
          payment: { ...MANUAL_PAYMENT, amount: 100 },
          invoice: { invoice_number: 'INV-0042', status: 'partial', amount_paid: 100, balance_due: 900, currency: 'USD' },
        },
        error: null,
      },
    })
    const json = body(
      await tools.get('update_payment')!.handler({ request_id: 'fix-1', payment_id: 'pay1', amount: 100 })
    )

    expect(json.invoice).toEqual({
      invoice_number: 'INV-0042',
      status: 'partial',
      amount_paid: 100,
      balance_due: 900,
    })
    expect(json.summary).toContain('now partial')
    expect(json.summary).toContain('$900.00 still due')
  })

  it('refuses a correction with nothing to change', async () => {
    const { tools, svc } = correctionSetup()
    const result = await tools.get('update_payment')!.handler({ request_id: 'fix-1', payment_id: 'pay1' })

    expect(result.isError).toBe(true)
    expect(rpcCalls(svc, 'update_payment')).toHaveLength(0)
  })

  it('refuses Stripe money with the refund path spelled out, without calling the RPC', async () => {
    const { tools, svc } = correctionSetup({
      'payments.select': { data: { ...MANUAL_PAYMENT, source: 'stripe' }, error: null },
    })
    const result = await tools.get('update_payment')!.handler({
      request_id: 'fix-1',
      payment_id: 'pay1',
      payment_date: '2026-06-15',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('refund')
    expect(rpcCalls(svc, 'update_payment')).toHaveLength(0)
  })

  it('translates the database refusal of Stripe money rather than leaking the code', async () => {
    const { tools } = correctionSetup({
      'rpc.update_payment': { data: null, error: { message: 'stripe_payment_locked' } },
    })
    const result = await tools.get('update_payment')!.handler({
      request_id: 'fix-1',
      payment_id: 'pay1',
      payment_date: '2026-06-15',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Stripe')
    expect(result.content[0].text).not.toContain('stripe_payment_locked')
  })

  it('explains an overpayment instead of reporting a generic failure', async () => {
    const { tools } = correctionSetup({
      'rpc.update_payment': { data: null, error: { message: 'amount_exceeds_invoice_total' } },
    })
    const result = await tools.get('update_payment')!.handler({
      request_id: 'fix-1',
      payment_id: 'pay1',
      amount: 99999,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('past its total')
  })

  it('refuses a payment belonging to another business, via ScopedDb', async () => {
    const { tools, svc } = correctionSetup({
      'payments.select': { data: { ...MANUAL_PAYMENT, business_id: 'bX' }, error: null },
    })
    const result = await tools.get('update_payment')!.handler({
      request_id: 'fix-1',
      payment_id: 'pay1',
      payment_date: '2026-06-15',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Payment not found')
    expect(rpcCalls(svc, 'update_payment')).toHaveLength(0)
  })

  it('voids with a reason and reports the reopened balance', async () => {
    const { tools, svc } = correctionSetup()
    const json = body(
      await tools.get('void_payment')!.handler({
        request_id: 'void-1',
        payment_id: 'pay1',
        reason: 'Recorded twice',
      })
    )

    expect(rpcCalls(svc, 'void_payment')[0].payload).toEqual({
      p_payment_id: 'pay1',
      p_request_id: 'void-1',
      p_reason: 'Recorded twice',
      p_actor_key_id: 'key1',
    })
    expect(json.payment.void_reason).toBe('Recorded twice')
    expect(json.invoice.status).toBe('sent')
    expect(json.summary).toContain('$1,000.00 still due')
  })

  it('refuses to void Stripe money without calling the RPC', async () => {
    const { tools, svc } = correctionSetup({
      'payments.select': { data: { ...MANUAL_PAYMENT, source: 'stripe' }, error: null },
    })
    const result = await tools.get('void_payment')!.handler({
      request_id: 'void-1',
      payment_id: 'pay1',
      reason: 'Wrong',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('refund')
    expect(rpcCalls(svc, 'void_payment')).toHaveLength(0)
  })

  it('reports a replay as a replay rather than as a second correction', async () => {
    const { tools } = correctionSetup({
      'rpc.update_payment': { data: { ...UPDATED, replayed: true }, error: null },
    })
    const json = body(
      await tools.get('update_payment')!.handler({
        request_id: 'fix-1',
        payment_id: 'pay1',
        payment_date: '2026-06-15',
      })
    )

    expect(json.replayed).toBe(true)
    expect(json.summary).toContain('replay')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'
import { BUSINESS_ID, CLIENT_ID, ROW_ID } from './action-fixture'

/**
 * The browser side of engagements part B: billing a schedule entry onto an
 * invoice, and turning an accepted quote into the agreement it was quoting.
 *
 * What these prove is the boundary, not the arithmetic. The arithmetic lives
 * in SQL and is asserted in supabase/tests/engagements.sql.
 * What can only be asserted here is that the action passes the entry ids and
 * NOT the money, and that a refusal comes back as the sentence a person is
 * shown rather than a Postgres error.
 */

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createInvoiceAction } from './invoices'
import { convertEstimateToEngagementAction } from './engagements'

const REQUEST_ID = '50000000-0000-4000-8000-000000000001'
const ENTRY_A = '70000000-0000-4000-8000-00000000000a'
const ENTRY_B = '70000000-0000-4000-8000-00000000000b'

const invoiceInput = {
  client_id: CLIENT_ID,
  invoice_number: 'INV-0042',
  issue_date: '2026-09-22',
  due_date: '2026-10-22',
  currency: 'USD',
  line_items: [
    {
      id: 'line-1',
      description: 'Consulting',
      quantity: 1,
      rate: 250,
      amount: 250,
      tax_rate: 0,
      tax_amount: 0,
      discount_percent: 0,
      discount_amount: 0,
    },
  ],
  subtotal: 250,
  discount_type: 'percentage' as const,
  discount_value: 0,
  discount_amount: 0,
  tax_rate: 0,
  tax_amount: 0,
  shipping_amount: 0,
  total: 250,
  is_recurring: false,
}

let db: FakeSupabase

function setup(overrides: Record<string, { data: unknown; error: unknown }> = {}) {
  db = createFakeSupabase({
    'rpc.create_invoice_document': { data: { id: ROW_ID, invoice_number: 'INV-0042' }, error: null },
    'rpc.convert_estimate_to_engagement': {
      data: { engagement: { id: 'eng1' } },
      error: null,
    },
    ...overrides,
  })
  createClientMock.mockResolvedValue(db)
}

function rpcPayload(fn: string) {
  return db.calls.find((call) => call.op === 'rpc' && call.table === fn)?.payload as
    | Record<string, unknown>
    | undefined
}

beforeEach(() => {
  createClientMock.mockReset()
  setup()
})

describe('createInvoiceAction with engagement entries', () => {
  it('passes the entry ids through and lets the database price them', async () => {
    await createInvoiceAction(BUSINESS_ID, invoiceInput, 'draft', REQUEST_ID, [ENTRY_A, ENTRY_B])

    const payload = rpcPayload('create_invoice_document')
    expect(payload).toMatchObject({
      p_business_id: BUSINESS_ID,
      p_request_id: REQUEST_ID,
      p_engagement_entry_ids: [ENTRY_A, ENTRY_B],
    })
    // No amount for an entry is ever sent from the browser.
    expect(JSON.stringify(payload?.p_lines)).not.toContain(ENTRY_A)
  })

  it('sends an empty list when nothing was billed off a schedule', async () => {
    await createInvoiceAction(BUSINESS_ID, invoiceInput, 'draft', REQUEST_ID)
    expect(rpcPayload('create_invoice_document')).toMatchObject({ p_engagement_entry_ids: [] })
  })

  it('turns a double billing refusal into a sentence a person can act on', async () => {
    setup({
      'rpc.create_invoice_document': {
        data: null,
        error: { message: 'engagement_entry_already_invoiced' },
      },
    })
    await expect(
      createInvoiceAction(BUSINESS_ID, invoiceInput, 'draft', REQUEST_ID, [ENTRY_A]),
    ).rejects.toThrow(/already on an invoice/)
  })

  it('keeps an unrelated database message rather than swallowing it', async () => {
    setup({
      'rpc.create_invoice_document': { data: null, error: { message: 'Invoice number already exists' } },
    })
    await expect(
      createInvoiceAction(BUSINESS_ID, invoiceInput, 'draft', REQUEST_ID),
    ).rejects.toThrow('Invoice number already exists')
  })
})

describe('convertEstimateToEngagementAction', () => {
  it('sends the schedule shape and never the quoted total or currency', async () => {
    const result = await convertEstimateToEngagementAction(
      ROW_ID,
      {
        billing_mode: 'percent_split',
        entries: [
          { label: 'Deposit', percent: 50 },
          { label: 'On delivery', percent: 50 },
        ],
      },
      REQUEST_ID,
    )

    expect(result).toEqual({ ok: true, engagementId: 'eng1' })
    const payload = rpcPayload('convert_estimate_to_engagement')
    expect(payload).toMatchObject({
      p_request_id: REQUEST_ID,
      p_estimate_id: ROW_ID,
      p_billing_mode: 'percent_split',
    })
    expect(payload).not.toHaveProperty('p_total')
    expect(payload).not.toHaveProperty('p_currency')
    expect(payload).not.toHaveProperty('p_client_id')
  })

  it('explains a quote that already became an invoice', async () => {
    setup({
      'rpc.convert_estimate_to_engagement': {
        data: null,
        error: { message: 'estimate_already_converted' },
      },
    })
    const result = await convertEstimateToEngagementAction(
      ROW_ID,
      { billing_mode: 'equal_installments', installments: 2 },
      REQUEST_ID,
    )
    expect(result).toEqual({
      error:
        'That estimate has already been converted into an invoice, so it cannot also become an engagement.',
    })
  })

  it('explains a quote that already became an engagement', async () => {
    setup({
      'rpc.convert_estimate_to_engagement': {
        data: null,
        error: { message: 'estimate_already_an_engagement' },
      },
    })
    const result = await convertEstimateToEngagementAction(
      ROW_ID,
      { billing_mode: 'equal_installments', installments: 2 },
      REQUEST_ID,
    )
    expect('error' in result && result.error).toMatch(/already become an engagement/)
  })

  it('refuses a billing mode it does not know, without calling the database', async () => {
    const result = await convertEstimateToEngagementAction(
      ROW_ID,
      { billing_mode: 'retainer' as never },
      REQUEST_ID,
    )
    expect('error' in result).toBe(true)
    expect(db.calls.some((call) => call.op === 'rpc')).toBe(false)
  })
})

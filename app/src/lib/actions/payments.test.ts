import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'
import { STRIPE_LOCKED_MESSAGE } from '@/lib/payments/messages'
import { BUSINESS_ID, ROW_ID } from './action-fixture'

/**
 * Recording, correcting and voiding a payment: each write reaches its RPC with
 * the caller's request id intact, and input the form could not have produced
 * never reaches the database.
 */

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { recordPaymentAction, updatePaymentAction, voidPaymentAction } from './payments'

const INVOICE_ID = '60000000-0000-4000-8000-000000000001'
const REQUEST_ID = '50000000-0000-4000-8000-000000000001'
/** The corrections take a TEXT request id, not a uuid. */
const CORRECTION_REQUEST = 'fix-1'

const recordInput = {
  invoice_id: INVOICE_ID,
  amount: 250,
  payment_date: '2026-09-22',
  payment_method: 'bank_transfer',
  reference_number: 'WIRE-88',
  notes: null,
}

const updateInput = {
  payment_date: '2026-09-01',
  method: 'check',
  notes: null,
  reference_number: '1042',
  amount: 100,
}

let db: FakeSupabase

function setup() {
  db = createFakeSupabase({
    'rpc.record_payment_once': { data: { payment_id: ROW_ID }, error: null },
    'rpc.update_payment': { data: { replayed: false }, error: null },
    'rpc.void_payment': { data: { replayed: false }, error: null },
  })
  createClientMock.mockResolvedValue(db)
}

beforeEach(() => {
  createClientMock.mockReset()
  setup()
})

describe('recordPaymentAction', () => {
  it('records, replaying one request id', async () => {
    const result = await recordPaymentAction(BUSINESS_ID, recordInput, REQUEST_ID)

    expect(result).toEqual({ ok: true })
    const rpc = db.calls.find((call) => call.op === 'rpc')
    expect(rpc?.fn).toBe('record_payment_once')
    expect(rpc?.payload).toMatchObject({
      p_request_id: REQUEST_ID,
      p_invoice_id: INVOICE_ID,
      p_amount: 250,
      p_payment_date: '2026-09-22',
      p_payment_method: 'bank_transfer',
      p_reference_number: 'WIRE-88',
      p_created_via: 'web',
    })
  })

  it('rejects an amount the form could not have produced', async () => {
    const result = await recordPaymentAction(BUSINESS_ID, { ...recordInput, amount: 0 }, REQUEST_ID)

    expect('error' in result).toBe(true)
    expect(db.calls.some((call) => call.op === 'rpc')).toBe(false)
  })
})

describe('updatePaymentAction', () => {
  it('corrects, keeping the dialog request id', async () => {
    const result = await updatePaymentAction(ROW_ID, updateInput, CORRECTION_REQUEST)

    expect(result).toEqual({ ok: true })
    const rpc = db.calls.find((call) => call.op === 'rpc')
    expect(rpc?.fn).toBe('update_payment')
    expect(rpc?.payload).toMatchObject({
      p_payment_id: ROW_ID,
      p_request_id: CORRECTION_REQUEST,
      p_payment_date: '2026-09-01',
      p_method: 'check',
      p_reference_number: '1042',
      p_amount: 100,
    })
  })

  it('turns a refusal from the RPC into a sentence a person can act on', async () => {
    db = createFakeSupabase({
        'rpc.update_payment': { data: null, error: { message: 'stripe_payment_locked' } },
    })
    createClientMock.mockResolvedValue(db)

    expect(await updatePaymentAction(ROW_ID, updateInput, CORRECTION_REQUEST)).toEqual({
      error: STRIPE_LOCKED_MESSAGE,
    })
  })
})

describe('voidPaymentAction', () => {
  it('voids with the reason and request id', async () => {
    const result = await voidPaymentAction(ROW_ID, '  Recorded twice  ', CORRECTION_REQUEST)

    expect(result).toEqual({ ok: true })
    const rpc = db.calls.find((call) => call.op === 'rpc')
    expect(rpc?.fn).toBe('void_payment')
    expect(rpc?.payload).toMatchObject({
      p_payment_id: ROW_ID,
      p_request_id: CORRECTION_REQUEST,
      p_reason: 'Recorded twice',
    })
  })

  it('will not void without a reason', async () => {
    const result = await voidPaymentAction(ROW_ID, '   ', CORRECTION_REQUEST)

    expect(result).toEqual({ error: 'Enter a reason for voiding this payment.' })
    expect(db.calls.some((call) => call.op === 'rpc')).toBe(false)
  })
})

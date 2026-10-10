import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'
import { BUSINESS_ID, CLIENT_ID, ROW_ID } from './action-fixture'

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createExpenseAction, deleteExpenseAction, updateExpenseAction } from './expenses'

const REQUEST_ID = '50000000-0000-4000-8000-000000000002'

const input = {
  client_id: CLIENT_ID,
  category: 'software',
  description: 'Design tool',
  amount: 25,
  date: '2026-09-22',
  vendor: 'Vendor',
  is_billable: false,
}

let db: FakeSupabase

function setup() {
  db = createFakeSupabase({
    'clients.select': { data: { currency: 'GBP' }, error: null },
    'businesses.select': { data: { default_currency: 'USD' }, error: null },
    'expenses.select': { data: { business_id: BUSINESS_ID }, error: null },
    'expenses.update': { data: [{ id: ROW_ID }], error: null },
    'expenses.delete': { data: [{ id: ROW_ID }], error: null },
    'rpc.create_work_entry_once': { data: { id: ROW_ID }, error: null },
  })
  createClientMock.mockResolvedValue(db)
}

beforeEach(() => {
  createClientMock.mockReset()
  setup()
})

describe('createExpenseAction', () => {
  it('records the expense, replaying one request id', async () => {
    expect(await createExpenseAction(BUSINESS_ID, input, REQUEST_ID)).toEqual({ ok: true })
    const rpc = db.calls.find((call) => call.op === 'rpc')
    const args = rpc?.payload as Record<string, unknown>
    expect(rpc?.fn).toBe('create_work_entry_once')
    expect(args.p_kind).toBe('expense')
    expect(args.p_request_id).toBe(REQUEST_ID)
    expect(args.p_record).toMatchObject({ amount: 25, currency: 'GBP' })
  })
})

describe('updateExpenseAction', () => {
  it('saves an edit without touching invoiced expenses', async () => {
    expect(await updateExpenseAction(ROW_ID, input)).toEqual({ ok: true })
    const update = db.calls.find((call) => call.op === 'update')
    expect(update?.payload).toMatchObject({ amount: 25, category: 'software' })
    expect(update?.filters.some((f) => f.method === 'is' && f.args[0] === 'invoice_id')).toBe(true)
  })
})

describe('deleteExpenseAction', () => {
  it('deletes an unbilled expense', async () => {
    expect(await deleteExpenseAction(ROW_ID)).toEqual({ ok: true })
  })
})

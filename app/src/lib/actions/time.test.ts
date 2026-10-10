import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'
import { BUSINESS_ID, CLIENT_ID, ROW_ID } from './action-fixture'

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createTimeEntryAction, deleteTimeEntryAction, updateTimeEntryAction } from './time'

const REQUEST_ID = '50000000-0000-4000-8000-000000000001'

const input = {
  client_id: CLIENT_ID,
  description: 'Design review',
  hours: 1,
  rate: 100,
  date: '2026-09-22',
  is_billable: true,
  project_name: null,
}

let db: FakeSupabase

function setup() {
  db = createFakeSupabase({
    'clients.select': { data: { currency: 'EUR' }, error: null },
    'businesses.select': { data: { default_currency: 'USD' }, error: null },
    'time_entries.select': { data: { business_id: BUSINESS_ID }, error: null },
    'time_entries.update': { data: [{ id: ROW_ID }], error: null },
    'time_entries.delete': { data: [{ id: ROW_ID }], error: null },
    'rpc.create_work_entry_once': { data: { id: ROW_ID }, error: null },
  })
  createClientMock.mockResolvedValue(db)
}

beforeEach(() => {
  createClientMock.mockReset()
  setup()
})

describe('createTimeEntryAction', () => {
  it('logs time, replaying one request id', async () => {
    const result = await createTimeEntryAction(BUSINESS_ID, input, REQUEST_ID)

    expect(result).toEqual({ ok: true })
    const rpc = db.calls.find((call) => call.op === 'rpc')
    expect(rpc?.fn).toBe('create_work_entry_once')
    const args = rpc?.payload as Record<string, unknown>
    expect(args.p_request_id).toBe(REQUEST_ID)
    expect(args.p_kind).toBe('time')
    expect(args.p_record).toMatchObject({
      duration_seconds: 3600,
      hourly_rate: 100,
      // Never taken from the browser: it follows the client being billed.
      currency: 'EUR',
    })
  })

  it('rejects an entry the form could not have produced', async () => {
    const result = await createTimeEntryAction(BUSINESS_ID, { ...input, hours: 99 }, REQUEST_ID)

    expect('error' in result).toBe(true)
    expect(db.calls.some((call) => call.op === 'rpc')).toBe(false)
  })
})

describe('updateTimeEntryAction', () => {
  it('saves an edit and leaves invoiced work alone', async () => {
    expect(await updateTimeEntryAction(ROW_ID, input)).toEqual({ ok: true })
    const update = db.calls.find((call) => call.op === 'update')
    expect(update?.table).toBe('time_entries')
    expect(update?.payload).toMatchObject({ duration_seconds: 3600, amount: 100 })
    // The invoiced-work filter survived the move off the browser.
    expect(update?.filters.some((f) => f.method === 'is' && f.args[0] === 'invoice_id')).toBe(true)
  })

  it('reports a refused edit rather than claiming success', async () => {
    db = createFakeSupabase({
      'clients.select': { data: { currency: 'USD' }, error: null },
      'time_entries.select': { data: { business_id: BUSINESS_ID }, error: null },
      'time_entries.update': { data: [], error: null },
    })
    createClientMock.mockResolvedValue(db)

    expect(await updateTimeEntryAction(ROW_ID, input)).toEqual({
      error: 'Invoiced work cannot be edited.',
    })
  })
})

describe('deleteTimeEntryAction', () => {
  it('deletes unbilled work', async () => {
    expect(await deleteTimeEntryAction(ROW_ID)).toEqual({ ok: true })
    const del = db.calls.find((call) => call.op === 'delete')
    expect(del?.filters.some((f) => f.method === 'is' && f.args[0] === 'invoice_id')).toBe(true)
  })
})

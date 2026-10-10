import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'
import { BUSINESS_ID, ROW_ID } from './action-fixture'

/**
 * Deleting invoices and estimates only ever removes drafts; deleting a client
 * archives it rather than removing it.
 */

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { deleteInvoiceAction } from './invoices'
import { deleteEstimateAction } from './estimates'
import { deleteClientAction } from './clients'

let db: FakeSupabase

function setup() {
  db = createFakeSupabase({
    'invoices.select': { data: { business_id: BUSINESS_ID, status: 'draft' }, error: null },
    'estimates.select': { data: { business_id: BUSINESS_ID, status: 'draft' }, error: null },
    'clients.select': { data: { business_id: BUSINESS_ID }, error: null },
    'invoices.delete': { data: null, error: null },
    'estimates.delete': { data: null, error: null },
    'clients.update': { data: null, error: null },
  })
  createClientMock.mockResolvedValue(db)
}

beforeEach(() => {
  createClientMock.mockReset()
  setup()
})

describe('deletes', () => {
  it('still go through, and still only for drafts', async () => {
    await deleteInvoiceAction(ROW_ID)
    await deleteEstimateAction(ROW_ID)
    await deleteClientAction(ROW_ID)

    expect(db.calls.filter((call) => call.op === 'delete')).toHaveLength(2)
    // Clients are archived rather than removed.
    expect(db.calls.find((call) => call.op === 'update')?.payload).toEqual({ is_active: false })
  })

  it('refuse a sent invoice for the old reason', async () => {
    db = createFakeSupabase({
      'invoices.select': { data: { business_id: BUSINESS_ID, status: 'sent' }, error: null },
    })
    createClientMock.mockResolvedValue(db)

    await expect(deleteInvoiceAction(ROW_ID)).rejects.toThrow(/Only draft invoices/)
  })
})

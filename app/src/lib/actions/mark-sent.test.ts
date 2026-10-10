import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'
import { ROW_ID } from './action-fixture'

/**
 * Marking a document sent by hand is how an owner without email opens its
 * public page. It moves a draft and nothing else, and a repeat click on a
 * document already past draft is a quiet no-op rather than an error.
 */

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { markInvoiceSentAction } from './invoices'
import { markEstimateSentAction } from './estimates'

let db: FakeSupabase

function useRows(rows: unknown[], current: unknown = null) {
  db = createFakeSupabase({
    'invoices.update': { data: rows, error: null },
    'estimates.update': { data: rows, error: null },
    'invoices.select': { data: current, error: null },
    'estimates.select': { data: current, error: null },
  })
  createClientMock.mockResolvedValue(db)
}

beforeEach(() => {
  createClientMock.mockReset()
  useRows([{ id: ROW_ID }])
})

describe('mark as sent', () => {
  it.each([
    ['invoices', markInvoiceSentAction],
    ['estimates', markEstimateSentAction],
  ] as const)('moves only a draft %s row to sent', async (table, action) => {
    await expect(action(ROW_ID)).resolves.toEqual({ changed: true, status: 'sent' })

    const update = db.calls.find((call) => call.op === 'update')
    expect(update?.table).toBe(table)
    expect(update?.payload).toEqual({ status: 'sent' })
    expect(update?.filters).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['id', ROW_ID] },
        { method: 'eq', args: ['status', 'draft'] },
      ]),
    )
  })

  it('leaves a document already past draft alone and reports its status', async () => {
    useRows([], { status: 'viewed' })

    await expect(markInvoiceSentAction(ROW_ID)).resolves.toEqual({ changed: false, status: 'viewed' })
    await expect(markEstimateSentAction(ROW_ID)).resolves.toEqual({ changed: false, status: 'viewed' })
  })

  it('still fails for a document the caller cannot see', async () => {
    useRows([])

    await expect(markInvoiceSentAction(ROW_ID)).rejects.toThrow(/Invoice not found/)
    await expect(markEstimateSentAction(ROW_ID)).rejects.toThrow(/Estimate not found/)
  })
})

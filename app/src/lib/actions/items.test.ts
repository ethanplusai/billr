import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'
import { BUSINESS_ID, ROW_ID } from './action-fixture'

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createItemAction, deleteItemAction, updateItemAction } from './items'

const input = { name: 'Design hour', description: null, rate: 150, unit: 'hour' }

let db: FakeSupabase

function setup() {
  db = createFakeSupabase({
    'items.insert': { data: null, error: null },
    'items.update': { data: [{ id: ROW_ID }], error: null },
    'items.delete': { data: null, error: null },
  })
  createClientMock.mockResolvedValue(db)
}

beforeEach(() => {
  createClientMock.mockReset()
  setup()
})

describe('item writes', () => {
  it('go through', async () => {
    expect(await createItemAction(BUSINESS_ID, input)).toEqual({ ok: true })
    expect(await updateItemAction(ROW_ID, input)).toEqual({ ok: true })
    expect(await deleteItemAction(ROW_ID)).toEqual({ ok: true })

    const insert = db.calls.find((call) => call.op === 'insert')
    expect(insert?.payload).toMatchObject({ business_id: BUSINESS_ID, name: 'Design hour' })
  })
})

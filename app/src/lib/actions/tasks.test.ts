import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'
import { BUSINESS_ID, CLIENT_ID, ROW_ID } from './action-fixture'

/**
 * Task billing writes: approving a pricing policy and turning a task into a
 * draft invoice.
 */

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { approvePricingPolicy, reviewTaskInvoice } from './tasks'

const policy = {
  business_id: BUSINESS_ID,
  client_id: CLIENT_ID,
  name: 'Development work',
  currency: 'USD',
  hourly_rate: 150,
  usage_multiplier: 1,
  budget: 5000,
}

const REQUEST_ID = '50000000-0000-4000-8000-000000000003'

let db: FakeSupabase

function setup() {
  db = createFakeSupabase({
    'billing_policies.insert': { data: { id: ROW_ID }, error: null },
    'rpc.task_operation': { data: { task: { invoice_id: ROW_ID } }, error: null },
  })
  createClientMock.mockResolvedValue(db)
}

beforeEach(() => {
  createClientMock.mockReset()
  setup()
})

describe('approvePricingPolicy', () => {
  it('records the policy', async () => {
    await expect(approvePricingPolicy(policy)).resolves.toEqual({ id: ROW_ID })
    expect(db.calls.find((call) => call.op === 'insert')?.payload).toMatchObject({
      business_id: BUSINESS_ID,
      budget: 5000,
    })
  })
})

describe('reviewTaskInvoice', () => {
  it('creates the draft, keeping the request id', async () => {
    await reviewTaskInvoice(BUSINESS_ID, ROW_ID, REQUEST_ID)
    const rpc = db.calls.find((call) => call.op === 'rpc')
    expect(rpc?.fn).toBe('task_operation')
    expect(rpc?.payload).toMatchObject({ p_request_id: REQUEST_ID, p_action: 'invoice' })
  })
})

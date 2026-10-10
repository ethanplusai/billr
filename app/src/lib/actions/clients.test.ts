import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'
import { BUSINESS_ID, ROW_ID } from './action-fixture'

/**
 * Application audit, Medium-3. Both client writes used to spread the caller's
 * argument into the insert and the update, after `business_id`, so a server
 * action POST could choose `business_id`, `id`, `created_at`, `created_via` and
 * `created_by_key_id`, and store unbounded text in `notes`.
 *
 * These tests are written against what is SENT to the database, not against
 * what the database would then refuse, because RLS refusing a forged
 * `business_id` is a second line and not the one under test here.
 */

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createClientAction, deleteClientAction, updateClientAction } from './clients'

const OTHER_BUSINESS = '20000000-0000-4000-8000-0000000000ff'

const valid = {
  name: 'Harbor & Lane',
  email: 'ap@harborlane.example',
  phone: '555-0100',
  website: 'https://harborlane.example',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: '',
  tax_id: '',
  currency: 'usd',
  payment_terms: 14,
  notes: '',
}

let db: FakeSupabase

beforeEach(() => {
  createClientMock.mockReset()
  db = createFakeSupabase({
    clients: { data: { id: ROW_ID }, error: null },
  })
  createClientMock.mockResolvedValue(db)
})

function writes() {
  return db.calls.filter((call) => call.op === 'insert' || call.op === 'update')
}

describe('createClientAction', () => {
  it('writes only the columns it names, with business_id from its own argument', async () => {
    await createClientAction(BUSINESS_ID, valid)

    expect(writes()).toHaveLength(1)
    expect(writes()[0].payload).toEqual({
      business_id: BUSINESS_ID,
      name: 'Harbor & Lane',
      email: 'ap@harborlane.example',
      phone: '555-0100',
      website: 'https://harborlane.example',
      address_line1: null,
      address_line2: null,
      city: null,
      state: null,
      postal_code: null,
      country: null,
      tax_id: null,
      currency: 'USD',
      payment_terms: 14,
      notes: null,
    })
  })

  it.each([
    ['business_id', { business_id: OTHER_BUSINESS }],
    ['id', { id: '00000000-0000-4000-8000-00000000dead' }],
    ['created_at', { created_at: '1999-01-01T00:00:00Z' }],
    ['created_via', { created_via: 'agent' }],
    ['created_by_key_id', { created_by_key_id: ROW_ID }],
    ['is_active', { is_active: false }],
  ])('refuses a smuggled %s and writes nothing', async (_label, extra) => {
    await expect(
      createClientAction(BUSINESS_ID, { ...valid, ...extra } as never),
    ).rejects.toThrow()
    expect(writes()).toHaveLength(0)
  })

  it('refuses unbounded notes', async () => {
    await expect(
      createClientAction(BUSINESS_ID, { ...valid, notes: 'x'.repeat(5001) }),
    ).rejects.toThrow()
    expect(writes()).toHaveLength(0)
  })

  it.each([
    ['a missing name', { name: '' }],
    ['a bad email', { email: 'not an address' }],
    ['a javascript: website', { website: 'javascript:alert(1)' }],
    ['a bad currency', { currency: 'DOLLARS' }],
    ['negative payment terms', { payment_terms: -1 }],
  ])('refuses %s', async (_label, patch) => {
    await expect(createClientAction(BUSINESS_ID, { ...valid, ...patch })).rejects.toThrow()
    expect(writes()).toHaveLength(0)
  })

  it('refuses a business id that is not a uuid', async () => {
    await expect(createClientAction('not-a-uuid', valid)).rejects.toThrow()
    expect(db.calls).toHaveLength(0)
  })
})

describe('updateClientAction', () => {
  it('never writes business_id, so an edit cannot move a client', async () => {
    await updateClientAction(ROW_ID, valid)

    expect(writes()).toHaveLength(1)
    expect(Object.keys(writes()[0].payload as object)).not.toContain('business_id')
  })

  it('refuses a smuggled business_id and writes nothing', async () => {
    await expect(
      updateClientAction(ROW_ID, { ...valid, business_id: OTHER_BUSINESS } as never),
    ).rejects.toThrow()
    expect(writes()).toHaveLength(0)
  })

  it('refuses a client id that is not a uuid', async () => {
    await expect(updateClientAction('../../etc', valid)).rejects.toThrow()
    expect(db.calls).toHaveLength(0)
  })
})

describe('deleteClientAction', () => {
  it('archives by writing is_active alone', async () => {
    await deleteClientAction(ROW_ID)

    expect(writes()).toHaveLength(1)
    expect(writes()[0].payload).toEqual({ is_active: false })
  })

  it('refuses a client id that is not a uuid', async () => {
    await expect(deleteClientAction('nope')).rejects.toThrow()
    expect(db.calls).toHaveLength(0)
  })
})

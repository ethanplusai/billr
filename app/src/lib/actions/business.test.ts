import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'
import { BUSINESS_ID } from './action-fixture'

/**
 * Settings writes: profile, invoice defaults and branding, each writing only
 * the columns it names.
 */

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import {
  updateBrandingAction,
  updateBusinessProfileAction,
  updateInvoiceDefaultsAction,
} from './business'

const profile = { name: 'Fieldstone Digital', email: '', website: '' }
const defaults = {
  default_currency: 'usd',
  default_payment_terms: 30,
  invoice_prefix: 'INV',
  estimate_prefix: 'EST',
  invoice_notes: '',
  invoice_footer: '',
}

let db: FakeSupabase

function setup() {
  db = createFakeSupabase({
    'businesses.update': { data: [{ id: BUSINESS_ID }], error: null },
  })
  createClientMock.mockResolvedValue(db)
}

beforeEach(() => {
  vi.unstubAllEnvs()
  createClientMock.mockReset()
  setup()
})

describe('business settings writes', () => {
  it('save, writing only the columns they name', async () => {
    expect(await updateBusinessProfileAction(BUSINESS_ID, profile)).toEqual({ ok: true })
    expect(await updateInvoiceDefaultsAction(BUSINESS_ID, defaults)).toEqual({ ok: true })
    expect(await updateBrandingAction(BUSINESS_ID, { primary_color: '#2563eb' })).toEqual({
      ok: true,
    })

    const updates = db.calls.filter((call) => call.op === 'update')
    expect(updates).toHaveLength(3)
    // Empty optional fields become NULL, and the currency is normalised.
    expect(updates[0].payload).toMatchObject({ email: null, website: null })
    expect(updates[1].payload).toMatchObject({ default_currency: 'USD' })
    expect(updates[2].payload).toEqual({ primary_color: '#2563eb' })
  })

  it('report a refusal rather than a silent success when RLS returns no rows', async () => {
    db = createFakeSupabase({
      'businesses.update': { data: [], error: null },
    })
    createClientMock.mockResolvedValue(db)

    expect(await updateBusinessProfileAction(BUSINESS_ID, profile)).toEqual({
      error: 'You cannot change that business.',
    })
  })

  it('refuse a branding call that would write nothing', async () => {
    expect(await updateBrandingAction(BUSINESS_ID, {})).toEqual({ error: 'Nothing to update.' })
  })
})

/**
 * The old schema was z.string().url(), which in zod 4 accepts
 * javascript:, data:, file: and vbscript:, and accepts any external host. The
 * value is rendered as an <img src> on the public document pages and fetched
 * server-side by the unauthenticated public PDF route, so it is constrained to
 * this installation's own storage.
 */
describe('branding logo_url', () => {
  const STORAGE = 'https://example-install.supabase.co'
  const uploaded = `${STORAGE}/storage/v1/object/public/logos/${BUSINESS_ID}/logo-1.png`

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', STORAGE)
  })

  it('accepts an upload on this installation storage origin', async () => {
    expect(await updateBrandingAction(BUSINESS_ID, { logo_url: uploaded })).toEqual({ ok: true })
    const update = db.calls.find((call) => call.op === 'update')
    expect(update?.payload).toEqual({ logo_url: uploaded })
  })

  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,iVBORw0KGgo=',
    'file:///etc/passwd',
    'https://evil.example/logo.png',
    `${STORAGE}/rest/v1/businesses?select=*`,
  ])('refuses %s and writes nothing', async (logo_url) => {
    const result = await updateBrandingAction(BUSINESS_ID, { logo_url })

    expect(result).not.toEqual({ ok: true })
    expect(db.calls.some((call) => call.op === 'update')).toBe(false)
  })

  it('clears the logo to NULL rather than storing an empty string', async () => {
    expect(await updateBrandingAction(BUSINESS_ID, { logo_url: '' })).toEqual({ ok: true })
    const update = db.calls.find((call) => call.op === 'update')
    expect(update?.payload).toEqual({ logo_url: null })
  })
})

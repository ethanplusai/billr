import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'

const { retrieve, create, update } = vi.hoisted(() => ({
  retrieve: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: { paymentIntents: { retrieve, create, update } },
}))
let db: FakeSupabase
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { publicDocument: {}, publicDocumentIp: {} },
  clientIpFrom: () => '203.0.113.5',
  consumeRateLimits: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  ipKey: (bucket: string, ip: string) => `${bucket}:${ip}`,
  rateLimitKey: (bucket: string, id: string) => `${bucket}:${id}`,
}))

import { POST } from './route'

const INVOICE = {
  id: 'inv_1',
  business_id: 'biz_1',
  invoice_number: 'INV-1001',
  status: 'sent',
  currency: 'USD',
  balance_due: 150,
  stripe_payment_intent_id: null as string | null,
}

function withInvoice(overrides: Partial<typeof INVOICE> = {}) {
  db = createFakeSupabase({
    'invoices.select': { data: { ...INVOICE, ...overrides }, error: null },
    'invoices.update': { data: null, error: null },
  })
}

function pay(publicId = 'pub_abc') {
  return POST(
    new NextRequest('http://localhost:3000/api/stripe/payment-intent', {
      method: 'POST',
      body: JSON.stringify({ public_id: publicId }),
    }),
  )
}

const invoiceUpdates = () =>
  db.calls.filter((c) => c.table === 'invoices' && c.op === 'update').map((c) => c.payload)

beforeEach(() => {
  retrieve.mockReset()
  create.mockReset()
  update.mockReset()
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example')
  vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_example')
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_example')
  withInvoice()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/stripe/payment-intent', () => {
  it('is unavailable, without calling Stripe, when card payments are not configured', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '')
    const response = await pay()
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ unavailable: true })
    expect(create).not.toHaveBeenCalled()
  })

  it('creates the intent on the installation account and remembers it on the invoice', async () => {
    create.mockResolvedValue({ id: 'pi_new', client_secret: 'pi_new_secret', status: 'requires_payment_method' })
    const response = await pay()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      client_secret: 'pi_new_secret',
      publishable_key: 'pk_test_example',
      amount: 15000,
      currency: 'USD',
    })
    const [params, options] = create.mock.calls[0]
    expect(params).toMatchObject({
      amount: 15000,
      currency: 'usd',
      metadata: { invoice_id: 'inv_1', business_id: 'biz_1', public_id: 'pub_abc' },
    })
    expect(options).toEqual({ idempotencyKey: 'billr:inv_1:initial:USD:15000' })
    expect(invoiceUpdates()).toEqual([{ stripe_payment_intent_id: 'pi_new', stripe_payment_status: null }])
  })

  it('charges a zero-decimal currency in whole units', async () => {
    withInvoice({ currency: 'JPY', balance_due: 5000 })
    create.mockResolvedValue({ id: 'pi_yen', client_secret: 'pi_yen_secret', status: 'requires_payment_method' })
    await pay()
    expect(create.mock.calls[0][0]).toMatchObject({ amount: 5000, currency: 'jpy' })
  })

  it('reuses an open intent for the same amount instead of creating another', async () => {
    withInvoice({ stripe_payment_intent_id: 'pi_open' })
    retrieve.mockResolvedValue({ id: 'pi_open', status: 'requires_payment_method', amount: 15000, currency: 'usd', client_secret: 'pi_open_secret' })
    const response = await pay()
    expect((await response.json()).client_secret).toBe('pi_open_secret')
    expect(create).not.toHaveBeenCalled()
    expect(invoiceUpdates()).toEqual([])
  })

  it('updates the amount of an open intent when the balance changed', async () => {
    withInvoice({ stripe_payment_intent_id: 'pi_open' })
    retrieve.mockResolvedValue({ id: 'pi_open', status: 'requires_payment_method', amount: 20000, currency: 'usd', client_secret: 'pi_open_secret' })
    update.mockResolvedValue({ id: 'pi_open', status: 'requires_payment_method', amount: 15000, currency: 'usd', client_secret: 'pi_open_secret' })
    await pay()
    expect(update).toHaveBeenCalledWith('pi_open', { amount: 15000 })
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a second form when the previous payment already went through', async () => {
    withInvoice({ stripe_payment_intent_id: 'pi_paid' })
    retrieve.mockResolvedValue({ id: 'pi_paid', status: 'succeeded', amount: 15000, currency: 'usd' })
    const response = await pay()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ status: 'processing' })
    expect(create).not.toHaveBeenCalled()
  })

  it('takes a new payment once the previous one is booked and the balance rose again', async () => {
    db = createFakeSupabase({
      'invoices.select': { data: { ...INVOICE, stripe_payment_intent_id: 'pi_paid' }, error: null },
      'invoices.update': { data: null, error: null },
      'payments.select': { data: { id: 'pay_1' }, error: null },
    })
    retrieve.mockResolvedValue({ id: 'pi_paid', status: 'succeeded', amount: 10000, currency: 'usd' })
    create.mockResolvedValue({ id: 'pi_topup', client_secret: 'pi_topup_secret', status: 'requires_payment_method' })
    const response = await pay()
    expect(response.status).toBe(200)
    const ledgerRead = db.calls.find((c) => c.table === 'payments' && c.op === 'select')
    expect(ledgerRead?.filters).toContainEqual({ method: 'eq', args: ['stripe_payment_id', 'pi_paid'] })
    expect(ledgerRead?.filters).toContainEqual({ method: 'eq', args: ['invoice_id', 'inv_1'] })
    expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: 'billr:inv_1:pi_paid:USD:15000' })
    expect(invoiceUpdates()).toEqual([{ stripe_payment_intent_id: 'pi_topup', stripe_payment_status: null }])
  })

  it('keeps refusing while the ledger cannot be checked for the previous payment', async () => {
    db = createFakeSupabase({
      'invoices.select': { data: { ...INVOICE, stripe_payment_intent_id: 'pi_paid' }, error: null },
      'payments.select': { data: null, error: { message: 'database unavailable' } },
    })
    retrieve.mockResolvedValue({ id: 'pi_paid', status: 'succeeded', amount: 15000, currency: 'usd' })
    const response = await pay()
    expect(response.status).toBe(503)
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps refusing a processing payment even if a row with its id exists', async () => {
    db = createFakeSupabase({
      'invoices.select': { data: { ...INVOICE, stripe_payment_intent_id: 'pi_slow' }, error: null },
      'payments.select': { data: { id: 'pay_1' }, error: null },
    })
    retrieve.mockResolvedValue({ id: 'pi_slow', status: 'processing', amount: 15000, currency: 'usd' })
    const response = await pay()
    expect(response.status).toBe(409)
    expect(create).not.toHaveBeenCalled()
  })

  it('does not create a new intent when the previous one cannot be checked', async () => {
    withInvoice({ stripe_payment_intent_id: 'pi_open' })
    retrieve.mockRejectedValue(Object.assign(new Error('Stripe is down'), { code: 'api_connection_error' }))
    const response = await pay()
    expect(response.status).toBe(502)
    expect(create).not.toHaveBeenCalled()
  })

  it('starts fresh when the remembered intent no longer exists on this account', async () => {
    withInvoice({ stripe_payment_intent_id: 'pi_gone' })
    retrieve.mockRejectedValue(Object.assign(new Error('No such payment_intent'), { code: 'resource_missing' }))
    create.mockResolvedValue({ id: 'pi_new', client_secret: 'pi_new_secret', status: 'requires_payment_method' })
    const response = await pay()
    expect(response.status).toBe(200)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('refuses a draft invoice without calling Stripe', async () => {
    withInvoice({ status: 'draft' })
    const response = await pay()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ unavailable: true })
    expect(create).not.toHaveBeenCalled()
  })

  it('asks the browser to retry when the invoice cannot record the attempt', async () => {
    db = createFakeSupabase({
      'invoices.select': { data: INVOICE, error: null },
      'invoices.update': { data: null, error: { message: 'database unavailable' } },
    })
    create.mockResolvedValue({ id: 'pi_new', client_secret: 'pi_new_secret', status: 'requires_payment_method' })
    const response = await pay()
    expect(response.status).toBe(503)
  })
})

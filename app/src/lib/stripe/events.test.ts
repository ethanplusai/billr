import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { createFakeSupabase, type FakeSupabase } from '@/lib/mcp/fake-supabase'

const { refundsList } = vi.hoisted(() => ({ refundsList: vi.fn() }))
vi.mock('@/lib/stripe/client', () => ({ stripe: { refunds: { list: refundsList } } }))

import { reconcileEvent } from './reconcile'
import { STRIPE_WEBHOOK_EVENTS } from './webhook-events'

const invoice = {
  id: 'i',
  business_id: 'b',
  client_id: 'c',
  currency: 'JPY',
  total: 1000,
  amount_paid: 0,
  status: 'sent',
  stripe_payment_intent_id: 'pi_current',
}

function setup(overrides: Record<string, unknown> = {}) {
  return createFakeSupabase({
    'invoices.select': { data: { ...invoice, ...overrides }, error: null },
    'invoices.update': { data: null, error: null },
    'rpc.record_stripe_payment': { data: null, error: null },
  })
}

const event = (type: string, object: object, account?: string) =>
  ({ id: 'evt_local', type, ...(account ? { account } : {}), data: { object } }) as Stripe.Event

const updates = (db: FakeSupabase) =>
  db.calls.filter((c) => c.table === 'invoices' && c.op === 'update').map((c) => c.payload)
const ledgerWrites = (db: FakeSupabase) =>
  db.calls.filter((c) => c.table === 'record_stripe_payment')

const paid = (metadata: Record<string, string> = { invoice_id: 'i', business_id: 'b' }, currency = 'jpy') => ({
  id: 'pi_current',
  metadata,
  amount_received: 1000,
  currency,
})

beforeEach(() => {
  refundsList.mockReset()
})

describe('verified Stripe event processing', () => {
  it('records a successful yen payment in yen, inside the database', async () => {
    const db = setup()
    await reconcileEvent(db as never, event('payment_intent.succeeded', paid()))
    expect(ledgerWrites(db)[0]?.payload).toMatchObject({
      p_amount: 1000,
      p_provider_id: 'pi_current',
      p_invoice_id: 'i',
    })
    expect(updates(db)).toEqual([{ stripe_payment_status: 'succeeded' }])
  })

  it('rejects a mismatched currency before touching the ledger', async () => {
    const db = setup()
    await expect(
      reconcileEvent(db as never, event('payment_intent.succeeded', paid(undefined, 'usd'))),
    ).rejects.toThrow('does not match invoice')
    expect(ledgerWrites(db)).toHaveLength(0)
  })

  it('rejects a PaymentIntent stamped with another business', async () => {
    const db = setup()
    await expect(
      reconcileEvent(
        db as never,
        event('payment_intent.succeeded', paid({ invoice_id: 'i', business_id: 'someone-else' })),
      ),
    ).rejects.toThrow('does not match invoice')
    expect(ledgerWrites(db)).toHaveLength(0)
  })

  it('ignores an event from a connected account without touching anything', async () => {
    const db = setup()
    await reconcileEvent(db as never, event('payment_intent.succeeded', paid(), 'acct_elsewhere'))
    expect(db.calls).toHaveLength(0)
  })

  it('ignores a PaymentIntent another app created on the same Stripe account', async () => {
    const db = createFakeSupabase({ 'invoices.select': { data: null, error: null } })
    await reconcileEvent(
      db as never,
      event('payment_intent.succeeded', { id: 'pi_other_app', metadata: {}, amount_received: 500, currency: 'usd' }),
    )
    expect(ledgerWrites(db)).toHaveLength(0)
    expect(updates(db)).toEqual([])
  })

  it('propagates database read failures so webhook delivery can retry', async () => {
    const db = createFakeSupabase({
      'invoices.select': { data: null, error: { message: 'database unavailable' } },
    })
    await expect(
      reconcileEvent(db as never, event('payment_intent.succeeded', paid())),
    ).rejects.toMatchObject({ message: 'database unavailable' })
  })
})

describe('failed card attempts', () => {
  it('records a declined card against the invoice without writing to the ledger', async () => {
    const db = setup()
    await reconcileEvent(
      db as never,
      event('payment_intent.payment_failed', {
        id: 'pi_current',
        metadata: { invoice_id: 'i' },
        currency: 'jpy',
        last_payment_error: { message: 'Your card was declined.' },
      }),
    )
    expect(updates(db)).toEqual([{ stripe_payment_status: 'failed' }])
    expect(ledgerWrites(db)).toHaveLength(0)
  })

  it('guards the write at the database so a payment landing mid-event still wins', async () => {
    const db = setup()
    await reconcileEvent(
      db as never,
      event('payment_intent.payment_failed', { id: 'pi_current', metadata: { invoice_id: 'i' }, currency: 'jpy' }),
    )
    const update = db.calls.find((c) => c.table === 'invoices' && c.op === 'update')
    expect(update?.filters).toContainEqual({ method: 'neq', args: ['status', 'paid'] })
  })

  it('ignores a failure for an attempt the invoice has already moved past', async () => {
    const db = setup()
    await reconcileEvent(
      db as never,
      event('payment_intent.payment_failed', { id: 'pi_superseded', metadata: { invoice_id: 'i' }, currency: 'jpy' }),
    )
    expect(updates(db)).toEqual([])
  })

  it('never downgrades an invoice that has already been paid', async () => {
    const db = setup({ status: 'paid' })
    await reconcileEvent(
      db as never,
      event('payment_intent.payment_failed', { id: 'pi_current', metadata: { invoice_id: 'i' }, currency: 'jpy' }),
    )
    expect(updates(db)).toEqual([])
  })

  it('clears a stale failure when the retry succeeds', async () => {
    const db = setup({ stripe_payment_status: 'failed' })
    await reconcileEvent(db as never, event('payment_intent.succeeded', paid()))
    expect(updates(db)).toEqual([{ stripe_payment_status: 'succeeded' }])
  })

  it('only marks the attempt succeeded on the invoice still pointing at that intent', async () => {
    // A replayed success for an earlier intent must not overwrite the state
    // of the attempt the invoice has since moved on to.
    const db = setup({ stripe_payment_intent_id: 'pi_newer' })
    await reconcileEvent(db as never, event('payment_intent.succeeded', paid()))
    const mark = db.calls.find((c) => c.table === 'invoices' && c.op === 'update')
    expect(mark?.payload).toEqual({ stripe_payment_status: 'succeeded' })
    expect(mark?.filters).toContainEqual({ method: 'eq', args: ['id', 'i'] })
    expect(mark?.filters).toContainEqual({ method: 'eq', args: ['stripe_payment_intent_id', 'pi_current'] })
  })

  it('records a three-decimal currency in thousandths', async () => {
    const db = setup({ currency: 'KWD', total: 12.345 })
    await reconcileEvent(db as never, event('payment_intent.succeeded', { ...paid(), currency: 'kwd', amount_received: 12345 }))
    expect(ledgerWrites(db)[0]?.payload).toMatchObject({ p_amount: 12.345, p_provider_id: 'pi_current' })
  })
})

describe('refunds and disputes', () => {
  it('records each refund once as a negative payment, listing refunds on this account', async () => {
    refundsList.mockResolvedValue({ data: [{ id: 're_1', status: 'succeeded', amount: 300 }], has_more: false })
    const db = setup()
    await reconcileEvent(
      db as never,
      event('charge.refunded', {
        id: 'ch_1',
        payment_intent: 'pi_current',
        metadata: { invoice_id: 'i', business_id: 'b' },
        currency: 'jpy',
      }),
    )
    expect(refundsList).toHaveBeenCalledWith({ charge: 'ch_1', limit: 100 })
    expect(ledgerWrites(db)[0]?.payload).toMatchObject({ p_amount: -300, p_provider_id: 're_1' })
  })

  it('records a refund of an earlier, already booked payment through the ledger', async () => {
    // No metadata on the charge and the invoice points at a newer attempt,
    // so only the ledger row for the earlier intent leads back to it.
    refundsList.mockResolvedValue({ data: [{ id: 're_old', status: 'succeeded', amount: 400 }], has_more: false })
    const db = createFakeSupabase({
      'invoices.select': (q) =>
        q.filters.some((f) => f.method === 'eq' && f.args[0] === 'id' && f.args[1] === 'i')
          ? { data: { ...invoice, stripe_payment_intent_id: 'pi_newer' }, error: null }
          : { data: null, error: null },
      'payments.select': { data: { invoice_id: 'i' }, error: null },
      'rpc.record_stripe_payment': { data: null, error: null },
    })
    await reconcileEvent(
      db as never,
      event('charge.refunded', { id: 'ch_old', payment_intent: 'pi_earlier', metadata: {}, currency: 'jpy' }),
    )
    const ledgerRead = db.calls.find((c) => c.table === 'payments' && c.op === 'select')
    expect(ledgerRead?.filters).toContainEqual({ method: 'eq', args: ['stripe_payment_id', 'pi_earlier'] })
    expect(refundsList).toHaveBeenCalledWith({ charge: 'ch_old', limit: 100 })
    expect(ledgerWrites(db)[0]?.payload).toMatchObject({ p_invoice_id: 'i', p_amount: -400, p_provider_id: 're_old' })
  })

  it('flags a disputed invoice', async () => {
    const db = setup()
    await reconcileEvent(db as never, event('charge.dispute.created', { payment_intent: 'pi_current', currency: 'jpy' }))
    expect(updates(db)).toContainEqual({ disputed: true })
  })

  it('flags the right invoice when the dispute is on an earlier, already booked payment', async () => {
    // The invoice has moved on to a newer attempt (its total was raised after
    // the first payment), so only the ledger still knows the earlier intent.
    const db = createFakeSupabase({
      'invoices.select': (q) =>
        q.filters.some((f) => f.method === 'eq' && f.args[0] === 'id' && f.args[1] === 'i')
          ? { data: { ...invoice, stripe_payment_intent_id: 'pi_newer' }, error: null }
          : { data: null, error: null },
      'payments.select': { data: { invoice_id: 'i' }, error: null },
      'invoices.update': { data: null, error: null },
    })
    await reconcileEvent(db as never, event('charge.dispute.created', { payment_intent: 'pi_earlier', currency: 'jpy' }))
    const ledgerRead = db.calls.find((c) => c.table === 'payments' && c.op === 'select')
    expect(ledgerRead?.filters).toContainEqual({ method: 'eq', args: ['stripe_payment_id', 'pi_earlier'] })
    const flag = db.calls.find((c) => c.table === 'invoices' && c.op === 'update')
    expect(flag?.payload).toEqual({ disputed: true })
    expect(flag?.filters).toContainEqual({ method: 'eq', args: ['id', 'i'] })
  })
})

describe('the webhook event list', () => {
  it('handles every event the setup instructions ask for, and ignores others', async () => {
    for (const type of STRIPE_WEBHOOK_EVENTS) {
      refundsList.mockResolvedValue({ data: [], has_more: false })
      const db = setup()
      await reconcileEvent(
        db as never,
        event(type, {
          id: 'pi_current',
          payment_intent: 'pi_current',
          metadata: { invoice_id: 'i' },
          currency: 'jpy',
          amount_received: 1000,
        }),
      )
      expect(db.calls.length, type).toBeGreaterThan(0)
    }
    const ignored = setup()
    await reconcileEvent(ignored as never, event('checkout.session.completed', { metadata: { invoice_id: 'i' } }))
    expect(ignored.calls).toHaveLength(0)
  })
})

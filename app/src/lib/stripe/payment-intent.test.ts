import { describe, it, expect } from 'vitest'
import {
  buildPaymentIntentParams,
  decidePaymentIntentReuse,
  isIntentSettled,
  type ExistingPaymentIntent,
} from './payment-intent'

const input = {
  currency: 'USD',
  invoiceNumber: 'INV-0007',
  balanceDue: 125.5,
  invoiceId: 'inv_1',
  businessId: 'biz_1',
  publicId: 'pub_1',
}

describe('buildPaymentIntentParams', () => {
  it('re-derives the amount server-side and lowercases the currency', () => {
    const params = buildPaymentIntentParams(input)
    expect(params.amount).toBe(12550)
    expect(params.currency).toBe('usd')
  })

  it('stamps invoice/business/public id metadata so every webhook handler can match it back', () => {
    // payment_intent.succeeded, charge.refunded and charge.dispute.created
    // all see the PaymentIntent or Charge, never a Checkout Session, so this
    // metadata is the only reliable link to the invoice.
    expect(buildPaymentIntentParams(input).metadata).toEqual({
      invoice_id: 'inv_1',
      business_id: 'biz_1',
      public_id: 'pub_1',
    })
  })

  it('creates a plain charge on this account: no fee and no transfer fields', () => {
    const params = buildPaymentIntentParams({
      currency: 'USD',
      invoiceNumber: 'INV-1001',
      balanceDue: 150,
      invoiceId: 'inv_1',
      businessId: 'biz_1',
      publicId: 'pub_abc',
    })
    expect(Object.keys(params).sort()).toEqual([
      'amount',
      'automatic_payment_methods',
      'currency',
      'description',
      'metadata',
    ])
  })

  it('accepts the string balance Postgres returns for DECIMAL columns', () => {
    expect(buildPaymentIntentParams({ ...input, balanceDue: '125.50' }).amount).toBe(12550)
  })
})

function existing(overrides: Partial<ExistingPaymentIntent>): ExistingPaymentIntent {
  return { status: 'requires_payment_method', amount: 12550, currency: 'usd', ...overrides }
}

describe('isIntentSettled', () => {
  it('treats succeeded, processing and requires_capture as money already taken', () => {
    expect(isIntentSettled('succeeded')).toBe(true)
    expect(isIntentSettled('processing')).toBe(true)
    expect(isIntentSettled('requires_capture')).toBe(true)
  })

  it('treats the pre-payment statuses as not settled', () => {
    expect(isIntentSettled('requires_payment_method')).toBe(false)
    expect(isIntentSettled('requires_confirmation')).toBe(false)
    expect(isIntentSettled('requires_action')).toBe(false)
    expect(isIntentSettled('canceled')).toBe(false)
  })
})

describe('decidePaymentIntentReuse', () => {
  it('creates a fresh intent when the invoice has none', () => {
    expect(decidePaymentIntentReuse(null, 12550, 'usd')).toBe('create')
  })

  it('reuses an unpaid intent for the same amount and currency', () => {
    expect(decidePaymentIntentReuse(existing({}), 12550, 'usd')).toBe('reuse')
    expect(decidePaymentIntentReuse(existing({ status: 'requires_confirmation' }), 12550, 'usd')).toBe(
      'reuse'
    )
    expect(decidePaymentIntentReuse(existing({ status: 'requires_action' }), 12550, 'usd')).toBe(
      'reuse'
    )
  })

  it('updates the intent when the balance due has changed (e.g. a partial payment landed)', () => {
    expect(decidePaymentIntentReuse(existing({ amount: 12550 }), 5000, 'usd')).toBe('update')
  })

  it('starts fresh when the currency changed, since an intent currency is immutable', () => {
    expect(decidePaymentIntentReuse(existing({ currency: 'gbp' }), 12550, 'usd')).toBe('create')
  })

  it('is case-insensitive about currency', () => {
    expect(decidePaymentIntentReuse(existing({ currency: 'USD' }), 12550, 'usd')).toBe('reuse')
  })

  it('starts fresh from a canceled intent', () => {
    expect(decidePaymentIntentReuse(existing({ status: 'canceled' }), 12550, 'usd')).toBe('create')
  })

  // The double-charge guard. The webhook may not have landed yet, so the
  // invoice still reads balance_due > 0; handing out a client secret here is
  // how a payer who reloads the page gets charged twice.
  it('refuses to hand out a payable intent once the money has been taken', () => {
    expect(decidePaymentIntentReuse(existing({ status: 'succeeded' }), 12550, 'usd')).toBe(
      'already_paid'
    )
    expect(decidePaymentIntentReuse(existing({ status: 'processing' }), 12550, 'usd')).toBe(
      'already_paid'
    )
    expect(decidePaymentIntentReuse(existing({ status: 'requires_capture' }), 12550, 'usd')).toBe(
      'already_paid'
    )
  })

  it('refuses even when the amount no longer matches, rather than updating a settled intent', () => {
    expect(decidePaymentIntentReuse(existing({ status: 'succeeded', amount: 999 }), 12550, 'usd')).toBe(
      'already_paid'
    )
  })
})

import { describe, it, expect } from 'vitest'
import {
  buildPaidPaymentInsert,
  buildRefundPaymentInserts,
  refundEventInputsFromStripeRefunds,
  recomputeInvoiceFromSum,
  decideFailedAttempt,
  extractDisputePaymentIntentId,
  type ReconcileInvoiceRow,
  type PaymentInsert,
} from './reconcile'

/**
 * A refund object shaped like what `stripe.refunds.list(...)` actually
 * returns (extra fields beyond what refundEventInputsFromStripeRefunds
 * reads, to prove it only depends on id/status/amount and tolerates the
 * rest of the real API response shape).
 */
function fetchedRefund(overrides: { id: string; amount: number; status?: 'succeeded' | 'pending' | 'failed' }) {
  return {
    id: overrides.id,
    object: 'refund' as const,
    amount: overrides.amount,
    status: overrides.status ?? 'succeeded',
    charge: 'ch_test',
    currency: 'usd',
    created: 1700000000,
    reason: null,
  }
}

const baseInvoice: ReconcileInvoiceRow = {
  id: 'invoice-1',
  business_id: 'business-1',
  client_id: 'client-1',
  currency: 'usd',
  total: 100,
  amount_paid: 0,
  status: 'sent',
}

/**
 * Test-only stand-in for the DB's unique index on payments.stripe_payment_id
 * (`ON CONFLICT (stripe_payment_id) DO NOTHING`), so the idempotency /
 * self-healing behavior of the real ledger + recompute flow can be exercised
 * purely, without a database. Mirrors exactly what insertPaymentIdempotent +
 * recomputeInvoice do in reconcile.ts's orchestration layer.
 */
function makeLedger() {
  const rows = new Map<string, PaymentInsert>()
  return {
    insert(row: PaymentInsert) {
      const key = row.stripe_payment_id ?? `no-key-${rows.size}`
      if (!rows.has(key)) rows.set(key, row)
    },
    sum() {
      return [...rows.values()].reduce((acc, r) => acc + r.amount, 0)
    },
    size() {
      return rows.size
    },
  }
}

describe('buildPaidPaymentInsert', () => {
  it('builds a payment row keyed on the stripe payment id, independent of current invoice state', () => {
    const row = buildPaidPaymentInsert(baseInvoice, 10000, 'pi_123', '2026-08-26')
    expect(row).toEqual({
      business_id: 'business-1',
      client_id: 'client-1',
      invoice_id: 'invoice-1',
      amount: 100,
      currency: 'usd',
      payment_method: 'stripe',
      stripe_payment_id: 'pi_123',
      payment_date: '2026-08-26',
      created_via: 'stripe',
    })
  })

  it('handles a null stripe payment id without throwing', () => {
    const row = buildPaidPaymentInsert(baseInvoice, 10000, null, '2026-08-26')
    expect(row.stripe_payment_id).toBeNull()
  })
})

describe('recomputeInvoiceFromSum', () => {
  it('full payment: sum equals total -> paid, paid_at set', () => {
    const update = recomputeInvoiceFromSum(baseInvoice, 100, '2026-08-26')
    expect(update).toEqual({ amount_paid: 100, balance_due: 0, status: 'paid', paid_at: '2026-08-26' })
  })

  it('partial payment: status partial, paid_at null', () => {
    const update = recomputeInvoiceFromSum(baseInvoice, 40, '2026-08-26')
    expect(update).toEqual({ amount_paid: 40, balance_due: 60, status: 'partial', paid_at: null })
  })

  it('zero/negative sum: status sent, paid_at null, clamped at 0', () => {
    expect(recomputeInvoiceFromSum(baseInvoice, 0, '2026-08-26')).toEqual({
      amount_paid: 0,
      balance_due: 100,
      status: 'sent',
      paid_at: null,
    })
    expect(recomputeInvoiceFromSum(baseInvoice, -20, '2026-08-26')).toEqual({
      amount_paid: 0,
      balance_due: 100,
      status: 'sent',
      paid_at: null,
    })
  })

  it('with no backfill id supplied, the returned update has no stripe_payment_intent_id key at all', () => {
    const update = recomputeInvoiceFromSum(baseInvoice, 40, '2026-08-26')
    expect('stripe_payment_intent_id' in update).toBe(false)
  })

  it('backfills stripe_payment_intent_id when the paid handler supplies the authoritative PI id from the event, regardless of the write when the intent was created', () => {
    const update = recomputeInvoiceFromSum(baseInvoice, 100, '2026-08-26', 'pi_authoritative')
    expect(update).toEqual({
      amount_paid: 100,
      balance_due: 0,
      status: 'paid',
      paid_at: '2026-08-26',
      stripe_payment_intent_id: 'pi_authoritative',
    })
  })

  it('does not backfill when no id is supplied (null/undefined), leaving the key absent', () => {
    expect('stripe_payment_intent_id' in recomputeInvoiceFromSum(baseInvoice, 40, '2026-08-26', null)).toBe(false)
    expect('stripe_payment_intent_id' in recomputeInvoiceFromSum(baseInvoice, 40, '2026-08-26', undefined)).toBe(
      false
    )
  })
})

describe('extractDisputePaymentIntentId', () => {
  it('extracts a string payment_intent id directly', () => {
    expect(extractDisputePaymentIntentId({ payment_intent: 'pi_disputed' })).toBe('pi_disputed')
  })

  it('extracts the id from an expanded PaymentIntent object', () => {
    expect(
      extractDisputePaymentIntentId({
        payment_intent: { id: 'pi_expanded' } as unknown as import('stripe').default.PaymentIntent,
      })
    ).toBe('pi_expanded')
  })

  it('returns null when payment_intent is null', () => {
    expect(extractDisputePaymentIntentId({ payment_intent: null })).toBeNull()
  })
})

describe('dispute matching by payment_intent id', () => {
  it('a dispute event whose payment_intent matches an invoice backfilled by the paid handler resolves to that invoice', () => {
    // Simulates the end-to-end sequence: the paid handler backfills
    // stripe_payment_intent_id via recomputeInvoiceFromSum's 4th param,
    // then a later charge.dispute.created event for the same PI must
    // resolve to the same id - proving the two are wired to the same key
    // without ever needing a stripe.charges.retrieve call.
    const invoiceUpdate = recomputeInvoiceFromSum(baseInvoice, 100, '2026-08-26', 'pi_shared')
    const disputePaymentIntentId = extractDisputePaymentIntentId({ payment_intent: 'pi_shared' })
    expect(invoiceUpdate.stripe_payment_intent_id).toBe(disputePaymentIntentId)
  })
})

describe('buildRefundPaymentInserts', () => {
  it('builds one negative-amount row per refund, keyed on the refund id (not the charge id)', () => {
    const rows = buildRefundPaymentInserts(
      baseInvoice,
      [
        { id: 're_1', amountCents: 3000 },
        { id: 're_2', amountCents: 2000 },
      ],
      '2026-08-27'
    )
    expect(rows).toEqual([
      {
        business_id: 'business-1',
        client_id: 'client-1',
        invoice_id: 'invoice-1',
        amount: -30,
        currency: 'usd',
        payment_method: 'stripe',
        stripe_payment_id: 're_1',
        payment_date: '2026-08-27',
        notes: 'Stripe refund',
        created_via: 'stripe',
      },
      {
        business_id: 'business-1',
        client_id: 'client-1',
        invoice_id: 'invoice-1',
        amount: -20,
        currency: 'usd',
        payment_method: 'stripe',
        stripe_payment_id: 're_2',
        payment_date: '2026-08-27',
        notes: 'Stripe refund',
        created_via: 'stripe',
      },
    ])
  })
})

describe('refundEventInputsFromStripeRefunds', () => {
  it('maps the fetched-list shape (stripe.refunds.list response) to RefundEventInput, ignoring extra fields', () => {
    const inputs = refundEventInputsFromStripeRefunds([
      fetchedRefund({ id: 're_1', amount: 3000 }),
      fetchedRefund({ id: 're_2', amount: 5000 }),
    ])
    expect(inputs).toEqual([
      { id: 're_1', amountCents: 3000 },
      { id: 're_2', amountCents: 5000 },
    ])
  })

  it('excludes refunds that are not yet succeeded (pending/failed)', () => {
    const inputs = refundEventInputsFromStripeRefunds([
      fetchedRefund({ id: 're_pending', amount: 1000, status: 'pending' }),
      fetchedRefund({ id: 're_failed', amount: 1000, status: 'failed' }),
      fetchedRefund({ id: 're_ok', amount: 1000, status: 'succeeded' }),
    ])
    expect(inputs).toEqual([{ id: 're_ok', amountCents: 1000 }])
  })

  it('excludes zero/negative-amount refund entries', () => {
    const inputs = refundEventInputsFromStripeRefunds([fetchedRefund({ id: 're_zero', amount: 0 })])
    expect(inputs).toEqual([])
  })

  it('returns an empty list (not a throw) when the fetched list is empty', () => {
    expect(refundEventInputsFromStripeRefunds([])).toEqual([])
  })
})

describe('ledger + recompute end-to-end scenarios (simulating the DB unique index + recompute-from-sum flow)', () => {
  it('C2: a paid event applied twice (same payment_intent id) yields ONE ledger row and the invoice paid exactly once', () => {
    const ledger = makeLedger()

    // First delivery of payment_intent.succeeded.
    ledger.insert(buildPaidPaymentInsert(baseInvoice, 10000, 'pi_dup', '2026-08-26'))
    let update = recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-26')
    expect(update).toEqual({ amount_paid: 100, balance_due: 0, status: 'paid', paid_at: '2026-08-26' })

    // A second delivery for the SAME payment_intent id - the
    // unique index (simulated by makeLedger's dedup-by-key) rejects the
    // duplicate insert; recompute still runs and must not double-count.
    ledger.insert(buildPaidPaymentInsert(baseInvoice, 10000, 'pi_dup', '2026-08-26'))
    update = recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-26')

    expect(ledger.size()).toBe(1)
    expect(update).toEqual({ amount_paid: 100, balance_due: 0, status: 'paid', paid_at: '2026-08-26' })
  })

  it('C1: retrying after a simulated invoice-update failure (payment row already inserted) converges to the correct state, not a double-count', () => {
    const ledger = makeLedger()

    // First attempt: payment row inserts fine, but imagine the subsequent
    // invoice UPDATE throws (network blip) - the caller in reconcile.ts
    // deletes the stripe_events row so Stripe retries the whole event.
    ledger.insert(buildPaidPaymentInsert(baseInvoice, 4000, 'pi_retry', '2026-08-26'))
    // (invoice update intentionally not applied here, simulating the failure)

    // Retry: reconcileEvent re-runs from scratch. The insert is a no-op
    // (already in the ledger from attempt 1), but recompute still runs.
    ledger.insert(buildPaidPaymentInsert(baseInvoice, 4000, 'pi_retry', '2026-08-26'))
    const update = recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-26')

    expect(ledger.size()).toBe(1)
    expect(update).toEqual({ amount_paid: 40, balance_due: 60, status: 'partial', paid_at: null })
  })

  it('I1: two partial refunds (first $30, then a second refund bringing the cumulative charge.amount_refunded to $80) net to exactly $50 refunded, not $80, and re-delivery of the first refund event does not double it', () => {
    const ledger = makeLedger()

    // Invoice fully paid first.
    ledger.insert(buildPaidPaymentInsert(baseInvoice, 10000, 'pi_refund_test', '2026-08-26'))

    // First charge.refunded event: the orchestration fetches the
    // authoritative refunds list from Stripe (not the webhook payload's
    // embedded charge.refunds.data), which at this point contains only
    // re_1, whose OWN amount is $30 (charge.amount_refunded is also 30 at
    // this point, so a cumulative-amount bug wouldn't yet be visible).
    let fetchedRefunds = refundEventInputsFromStripeRefunds([fetchedRefund({ id: 're_1', amount: 3000 })])
    for (const row of buildRefundPaymentInserts(baseInvoice, fetchedRefunds, '2026-08-27')) {
      ledger.insert(row)
    }
    let update = recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-27')
    expect(update.amount_paid).toBe(70)

    // A second, separate $50 refund (re_2) is issued. The authoritative
    // fetched list now returns BOTH refund objects: re_1 ($30, already
    // recorded) and re_2 ($50, new). Using each refund's own incremental
    // amount (never charge.amount_refunded, which would now cumulatively
    // read $80) and deduping re_1 by id keeps the total correct.
    fetchedRefunds = refundEventInputsFromStripeRefunds([
      fetchedRefund({ id: 're_1', amount: 3000 }),
      fetchedRefund({ id: 're_2', amount: 5000 }),
    ])
    for (const row of buildRefundPaymentInserts(baseInvoice, fetchedRefunds, '2026-08-27')) {
      ledger.insert(row)
    }
    update = recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-27')

    // Total refunded is $30 + $50 = $80, so amount_paid nets to $20 - not
    // $100 - $80(cumulative)-$30(re-added) = -$10 or any other double-count.
    expect(ledger.size()).toBe(3) // pi_refund_test, re_1, re_2
    expect(update).toEqual({ amount_paid: 20, balance_due: 80, status: 'partial', paid_at: null })
  })

  it('I2 (webhook-payload-independence): a fetched refunds list with more entries than the webhook payload embedded (simulating a truncated/absent charge.refunds.data) is still fully applied', () => {
    const ledger = makeLedger()
    ledger.insert(buildPaidPaymentInsert(baseInvoice, 10000, 'pi_many_refunds', '2026-08-26'))

    // Simulates the case the coordinator flagged: the webhook payload's
    // embedded refunds list would have been empty/truncated, but the
    // authoritative fetched list (what stripe.refunds.list actually
    // returns) has every refund.
    const fetchedRefunds = refundEventInputsFromStripeRefunds([
      fetchedRefund({ id: 're_a', amount: 1000 }),
      fetchedRefund({ id: 're_b', amount: 1500 }),
      fetchedRefund({ id: 're_c', amount: 2000 }),
    ])
    for (const row of buildRefundPaymentInserts(baseInvoice, fetchedRefunds, '2026-08-27')) {
      ledger.insert(row)
    }
    const update = recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-27')

    expect(ledger.size()).toBe(4) // pi_many_refunds, re_a, re_b, re_c
    expect(update).toEqual({ amount_paid: 55, balance_due: 45, status: 'partial', paid_at: null })
  })

  it('over-refund (refund total exceeding what was paid) clamps amount_paid at 0 rather than going negative', () => {
    const ledger = makeLedger()
    ledger.insert(buildPaidPaymentInsert(baseInvoice, 10000, 'pi_over', '2026-08-26'))
    const fetchedRefunds = refundEventInputsFromStripeRefunds([fetchedRefund({ id: 're_over', amount: 20000 })])
    for (const row of buildRefundPaymentInserts(baseInvoice, fetchedRefunds, '2026-08-27')) {
      ledger.insert(row)
    }
    const update = recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-27')
    expect(update).toEqual({ amount_paid: 0, balance_due: 100, status: 'sent', paid_at: null })
  })
})

describe('embedded Payment Element path: one PaymentIntent can only ever record one payment', () => {
  // The Payment Element does not create a Checkout Session, so the only
  // paid event it produces is payment_intent.succeeded. These lock in that
  // the new path cannot double-record, which is exactly the class of bug
  // this codebase has already had twice.

  it('a redelivered payment_intent.succeeded records once and converges on the same invoice state', () => {
    const ledger = makeLedger()
    const row = buildPaidPaymentInsert(baseInvoice, 10000, 'pi_embedded', '2026-08-26')

    ledger.insert(row)
    const first = recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-26')

    // Stripe redelivers the identical event (at-least-once delivery).
    ledger.insert(buildPaidPaymentInsert(baseInvoice, 10000, 'pi_embedded', '2026-08-26'))
    const second = recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-26')

    expect(ledger.size()).toBe(1)
    expect(second).toEqual(first)
    expect(second).toEqual({ amount_paid: 100, balance_due: 0, status: 'paid', paid_at: '2026-08-26' })
  })

  it('two genuinely different intents against one invoice are two ledger rows, and the recompute still nets correctly', () => {
    // e.g. the amount changed and a new intent was created for the remainder.
    const ledger = makeLedger()
    ledger.insert(buildPaidPaymentInsert(baseInvoice, 4000, 'pi_first', '2026-08-26'))
    expect(recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-26')).toEqual({
      amount_paid: 40,
      balance_due: 60,
      status: 'partial',
      paid_at: null,
    })

    ledger.insert(buildPaidPaymentInsert(baseInvoice, 6000, 'pi_second', '2026-08-27'))
    expect(ledger.size()).toBe(2)
    expect(recomputeInvoiceFromSum(baseInvoice, ledger.sum(), '2026-08-27')).toEqual({
      amount_paid: 100,
      balance_due: 0,
      status: 'paid',
      paid_at: '2026-08-27',
    })
  })
})

describe('decideFailedAttempt', () => {
  const current = {
    status: 'sent',
    stripe_payment_intent_id: 'pi_current',
  }

  it('records the current attempt as failed', () => {
    expect(decideFailedAttempt(current, 'pi_current')).toEqual({
      stripe_payment_status: 'failed',
    })
  })

  it('ignores an attempt the invoice has already superseded', () => {
    expect(decideFailedAttempt(current, 'pi_old')).toBeNull()
  })

  it('accepts the first attempt on an invoice that has no attempt recorded yet', () => {
    const fresh = { status: 'sent', stripe_payment_intent_id: null }
    expect(decideFailedAttempt(fresh, 'pi_1')).toEqual({
      stripe_payment_status: 'failed',
    })
  })

  it('never downgrades a paid invoice, whatever the event says', () => {
    const paid = { ...current, status: 'paid' }
    expect(decideFailedAttempt(paid, 'pi_current')).toBeNull()
  })

  it('ignores an event with no attempt id to bind to', () => {
    expect(decideFailedAttempt(current, null)).toBeNull()
  })

  it('is idempotent: replaying the same event yields the same decision', () => {
    const first = decideFailedAttempt(current, 'pi_current')
    const second = decideFailedAttempt(current, 'pi_current')
    expect(second).toEqual(first)
  })
})

import { describe, it, expect } from 'vitest'
import { computePaymentUpdate } from './payment-math'

describe('computePaymentUpdate', () => {
  it('full payment marks paid, balance 0', () => {
    expect(computePaymentUpdate({ total: 100, amount_paid: 0 }, 100))
      .toEqual({ amount_paid: 100, balance_due: 0, status: 'paid' })
  })
  it('partial payment marks partial', () => {
    expect(computePaymentUpdate({ total: 100, amount_paid: 0 }, 40))
      .toEqual({ amount_paid: 40, balance_due: 60, status: 'partial' })
  })
  it('overpayment clamps balance to 0 and marks paid', () => {
    expect(computePaymentUpdate({ total: 100, amount_paid: 0 }, 150))
      .toEqual({ amount_paid: 150, balance_due: 0, status: 'paid' })
  })
  it('refund reversal that empties payment returns to sent', () => {
    expect(computePaymentUpdate({ total: 100, amount_paid: 100 }, -100))
      .toEqual({ amount_paid: 0, balance_due: 100, status: 'sent' })
  })
  it('partial refund keeps partial', () => {
    expect(computePaymentUpdate({ total: 100, amount_paid: 100 }, -40))
      .toEqual({ amount_paid: 60, balance_due: 40, status: 'partial' })
  })
})

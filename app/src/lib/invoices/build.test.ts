import { describe, it, expect } from 'vitest'
import { computeInvoiceTotals, nextInvoiceNumber } from '@/lib/invoices/build'

describe('computeInvoiceTotals', () => {
  it('computes plain lines with no discount/tax/shipping', () => {
    const result = computeInvoiceTotals([
      { description: 'Design', quantity: 2, rate: 100 },
      { description: 'Dev', quantity: 3, rate: 50 },
    ])

    expect(result.line_items).toEqual([
      { description: 'Design', quantity: 2, rate: 100, amount: 200 },
      { description: 'Dev', quantity: 3, rate: 50, amount: 150 },
    ])
    expect(result.subtotal).toBe(350)
    expect(result.discount_amount).toBe(0)
    expect(result.tax_amount).toBe(0)
    expect(result.total).toBe(350)
  })

  it('rounds quantity x rate to 2dp per line, but sums the RAW (unrounded) amounts for the subtotal', () => {
    const result = computeInvoiceTotals([
      { description: 'Consulting', quantity: 1.1, rate: 33.333 },
      { description: 'Support', quantity: 3, rate: 10.005 },
    ])

    expect(result.line_items[0].amount).toBe(36.67)
    expect(result.line_items[1].amount).toBe(30.02)

    expect(result.subtotal).toBe(66.69)
  })

  it('keeps displayed lines, discount, tax and total arithmetically consistent', () => {
    const result = computeInvoiceTotals(
      [
        { description: 'Consulting', quantity: 1.1, rate: 33.333 },
        { description: 'Support', quantity: 3, rate: 10.005 },
      ],
      { discount_type: 'percentage', discount_value: 15, tax_rate: 8.25, shipping_amount: 2.5 }
    )

    expect(result.subtotal).toBe(66.69)
    expect(result.discount_amount).toBe(10)
    expect(result.tax_amount).toBe(4.68)
    expect(result.total).toBe(63.87)
  })

  it('computes tax from the displayed subtotal less the displayed discount', () => {
    const result = computeInvoiceTotals(
      [
        { description: 'A', quantity: 1, rate: 12.345 },
        { description: 'B', quantity: 1, rate: 17.283 },
      ],
      { discount_type: 'percentage', discount_value: 12.5, tax_rate: 7 }
    )

    expect(result.subtotal).toBe(29.63)
    expect(result.discount_amount).toBe(3.7)
    expect(result.tax_amount).toBe(1.82)
    expect(result.total).toBe(27.75)
  })

  it('applies a percentage discount on the subtotal', () => {
    const result = computeInvoiceTotals(
      [{ description: 'Widget', quantity: 10, rate: 100 }],
      { discount_type: 'percentage', discount_value: 15 }
    )

    expect(result.subtotal).toBe(1000)
    expect(result.discount_amount).toBe(150)
    expect(result.total).toBe(850)
  })

  it('applies a fixed discount clamped to the subtotal', () => {
    const result = computeInvoiceTotals(
      [{ description: 'Widget', quantity: 1, rate: 40 }],
      { discount_type: 'fixed', discount_value: 500 }
    )

    expect(result.subtotal).toBe(40)
    expect(result.discount_amount).toBe(40)
    expect(result.total).toBe(0)
  })

  it('computes tax on the post-discount subtotal, not the raw subtotal', () => {
    const result = computeInvoiceTotals(
      [{ description: 'Widget', quantity: 1, rate: 1000 }],
      { discount_type: 'percentage', discount_value: 10, tax_rate: 8 }
    )

    expect(result.discount_amount).toBe(100)
    expect(result.tax_amount).toBe(72)
    expect(result.total).toBe(972)
  })

  it('adds shipping after discount and tax', () => {
    const result = computeInvoiceTotals(
      [{ description: 'Widget', quantity: 1, rate: 100 }],
      { tax_rate: 10, shipping_amount: 25 }
    )

    expect(result.subtotal).toBe(100)
    expect(result.tax_amount).toBe(10)
    expect(result.total).toBe(135)
  })

  it('handles zero line items', () => {
    const result = computeInvoiceTotals([], { tax_rate: 10, shipping_amount: 5 })

    expect(result.line_items).toEqual([])
    expect(result.subtotal).toBe(0)
    expect(result.discount_amount).toBe(0)
    expect(result.tax_amount).toBe(0)
    expect(result.total).toBe(5)
  })
})

describe('nextInvoiceNumber', () => {
  it('formats a prefix and number padded to 4 digits', () => {
    expect(nextInvoiceNumber('INV', 1146)).toBe('INV-1146')
  })

  it('pads small numbers with leading zeros', () => {
    expect(nextInvoiceNumber('INV', 4)).toBe('INV-0004')
  })

  it('does not truncate numbers wider than 4 digits', () => {
    expect(nextInvoiceNumber('INV', 12345)).toBe('INV-12345')
  })
})

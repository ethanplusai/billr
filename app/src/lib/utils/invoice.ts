import { nanoid } from 'nanoid'
import type { LineItemFormData } from '@/lib/validations/invoice'

export function generatePublicId(): string {
  return nanoid(10) // Short, URL-safe ID
}

const roundMoney=(n:number)=>Math.round((n+Number.EPSILON)*100)/100

export function calculateLineItemAmount(item: LineItemFormData): LineItemFormData {
  const baseAmount = item.quantity * item.rate
  const discountAmount = (baseAmount * item.discount_percent) / 100
  const afterDiscount = baseAmount - discountAmount

  // Note: the editor has no per-line tax inputs, so per-line tax is
  // intentionally kept at 0. Tax is applied invoice-wide in
  // calculateInvoiceTotals to keep line amounts and totals consistent.
  return {
    ...item,
    discount_amount: roundMoney(discountAmount),
    tax_amount: 0,
    amount: roundMoney(afterDiscount),
  }
}

export function calculateInvoiceTotals(
  lineItems: LineItemFormData[],
  discountType: 'percentage' | 'fixed',
  discountValue: number,
  taxRate: number,
  shippingAmount: number
) {
  // Calculate subtotal from line items
  const subtotal = roundMoney(lineItems.reduce((sum, item) => sum + calculateLineItemAmount(item).amount, 0))
  
  // Calculate discount (fixed discounts are clamped so totals never go negative)
  const discountAmount = discountType === 'percentage'
    ? roundMoney((subtotal * discountValue) / 100)
    : roundMoney(Math.min(discountValue, subtotal))

  const afterDiscount = subtotal - discountAmount
  
  // Calculate tax on discounted amount
  const taxAmount = roundMoney((afterDiscount * taxRate) / 100)
  
  // Calculate total
  const total = roundMoney(afterDiscount + taxAmount + shippingAmount)

  return {
    subtotal,
    discount_amount: roundMoney(discountAmount),
    tax_amount: taxAmount,
    total,
  }
}

export function createEmptyLineItem(): LineItemFormData {
  return {
    id: nanoid(),
    description: '',
    quantity: 1,
    rate: 0,
    amount: 0,
    tax_rate: 0,
    tax_amount: 0,
    discount_percent: 0,
    discount_amount: 0,
  }
}

export function formatInvoiceNumber(prefix: string, number: number): string {
  return `${prefix}-${number.toString().padStart(4, '0')}`
}


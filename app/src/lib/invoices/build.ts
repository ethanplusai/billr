/** Canonical invoice arithmetic: round each displayed line, then discount and tax.
 * The sum of the displayed components must equal the amount due. SQL invoice
 * creation and the human editor follow this same order.
 */
export interface BuildLineItem {
  description?: string
  quantity: number
  rate: number
}

interface ComputedLineItem extends BuildLineItem {
  amount: number
}

export interface InvoiceTotalsOptions {
  discount_type?: 'percentage' | 'fixed'
  discount_value?: number
  tax_rate?: number
  shipping_amount?: number
}

export interface InvoiceTotals {
  line_items: ComputedLineItem[]
  subtotal: number
  discount_amount: number
  tax_amount: number
  total: number
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function computeInvoiceTotals(
  lineItems: BuildLineItem[],
  opts: InvoiceTotalsOptions = {}
): InvoiceTotals {
  const discountType = opts.discount_type ?? 'percentage'
  const discountValue = opts.discount_value ?? 0
  const taxRate = opts.tax_rate ?? 0
  const shippingAmount = opts.shipping_amount ?? 0

  // Raw (unrounded) intermediates, carried through in the app's exact order.
  const rawLineAmounts = lineItems.map((item) => round2(item.quantity * item.rate))
  const rawSubtotal = rawLineAmounts.reduce((sum, amount) => sum + amount, 0)

  const rawDiscountAmount =
    discountType === 'percentage'
      ? round2((rawSubtotal * discountValue) / 100)
      : round2(Math.min(discountValue, rawSubtotal))

  const rawAfterDiscount = rawSubtotal - rawDiscountAmount
  const rawTaxAmount = round2((rawAfterDiscount * taxRate) / 100)
  const rawTotal = rawAfterDiscount + rawTaxAmount + shippingAmount

  // Each output field is rounded exactly once, from its own raw value.
  const computedLineItems: ComputedLineItem[] = lineItems.map((item, index) => ({
    ...item,
    amount: round2(rawLineAmounts[index]),
  }))

  return {
    line_items: computedLineItems,
    subtotal: round2(rawSubtotal),
    discount_amount: round2(rawDiscountAmount),
    tax_amount: round2(rawTaxAmount),
    total: round2(rawTotal),
  }
}

/** Formats an invoice number the same way `formatInvoiceNumber` does in `utils/invoice.ts`. */
export function nextInvoiceNumber(prefix: string, number: number): string {
  return `${prefix}-${number.toString().padStart(4, '0')}`
}

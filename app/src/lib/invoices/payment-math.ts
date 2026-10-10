export function computePaymentUpdate(
  invoice: { total: number; amount_paid: number },
  delta: number
): { amount_paid: number; balance_due: number; status: 'paid' | 'partial' | 'sent' } {
  const amountPaid = Math.max(0, invoice.amount_paid + delta)
  const balanceDue = Math.max(0, invoice.total - amountPaid)
  const status = amountPaid <= 0 ? 'sent' : balanceDue <= 0 ? 'paid' : 'partial'
  return { amount_paid: amountPaid, balance_due: balanceDue, status }
}

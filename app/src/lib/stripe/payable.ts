import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { amountToMinorUnits } from '@/lib/stripe/money'

/**
 * One deliberately vague message for every "we will not charge this card"
 * outcome. The payer is an anonymous visitor, so the reason must not leak.
 */
export const NOT_PAYABLE =
  'This invoice cannot be paid online right now. Please use the payment instructions on the invoice, or contact the sender.'

const PAYABLE_COLUMNS =
  'id, business_id, invoice_number, status, currency, balance_due, stripe_payment_intent_id'

interface PayableInvoice {
  id: string
  business_id: string
  invoice_number: string
  status: string
  currency: string
  /** Server-authoritative outstanding amount in major units. */
  balanceDue: number
  stripe_payment_intent_id: string | null
}

export type PayableResult =
  | { ok: true; invoice: PayableInvoice }
  | { ok: false; status: number; error: string }

/**
 * Every check that must pass before Billr creates a charge for a public
 * invoice. Reads the invoice by its own unguessable public_id (never a
 * caller-supplied internal id) and re-derives the amount from that row rather
 * than trusting anything the browser sent.
 */
export async function loadPayableInvoice(
  db: SupabaseClient<Database>,
  publicId: string,
): Promise<PayableResult> {
  const { data: invoice, error } = await db
    .from('invoices')
    .select(PAYABLE_COLUMNS)
    .eq('public_id', publicId)
    .maybeSingle()

  if (error) return { ok: false, status: 503, error: NOT_PAYABLE }
  if (!invoice) return { ok: false, status: 404, error: 'Invoice not found.' }
  if (['draft', 'cancelled', 'paid'].includes(invoice.status))
    return { ok: false, status: 409, error: NOT_PAYABLE }

  const balanceDue = Number(invoice.balance_due)
  if (!(balanceDue > 0)) return { ok: false, status: 409, error: NOT_PAYABLE }
  try {
    amountToMinorUnits(balanceDue, invoice.currency)
  } catch {
    return { ok: false, status: 409, error: NOT_PAYABLE }
  }

  return {
    ok: true,
    invoice: {
      id: invoice.id,
      business_id: invoice.business_id,
      invoice_number: invoice.invoice_number,
      status: invoice.status,
      currency: invoice.currency,
      balanceDue,
      stripe_payment_intent_id: invoice.stripe_payment_intent_id ?? null,
    },
  }
}

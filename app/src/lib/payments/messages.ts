/**
 * The sentences a person sees when a payment write is refused.
 *
 * These used to live inside the corrections dialog, which was fine while the
 * browser called the RPCs itself. The writes now run inside server actions
 * (src/lib/actions/payments.ts), so the action is what turns a Postgres error
 * into something worth reading and the dialog just shows what it gets. This
 * module is plain TypeScript so both sides may import it: a 'use server' file
 * may only export async functions, and a 'use client' file must not be pulled
 * into the server bundle.
 */

export const STRIPE_LOCKED_MESSAGE =
  'Collected through Stripe. Card payments cannot be edited or voided here. Refund the charge in Stripe and the refund comes back as its own entry.'

/** Turns a Postgres error from the payment RPCs into a sentence to act on. */
export function correctionMessage(message: string, fallback: string): string {
  if (message.includes('stripe_payment_locked')) return STRIPE_LOCKED_MESSAGE
  if (message.includes('payment_already_voided')) return 'This payment has already been voided.'
  if (message.includes('amount_exceeds_invoice_total'))
    return 'That amount would take the invoice past its total once the other payments on it are counted.'
  if (message.includes('request_id_reused')) return 'That correction was already saved with different values.'
  if (message.includes('void_reason_required')) return 'Enter a reason for voiding this payment.'
  if (message.includes('invalid_amount')) return 'The amount must be greater than zero.'
  if (message.includes('payment_not_found')) return 'That payment could not be found.'
  return fallback
}

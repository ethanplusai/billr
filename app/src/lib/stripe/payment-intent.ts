import 'server-only'
import type Stripe from 'stripe'
import { amountToMinorUnits } from '@/lib/stripe/money'

export interface PaymentIntentInput {
  currency: string
  invoiceNumber: string
  /** Server-authoritative outstanding amount, in major currency units. */
  balanceDue: number | string
  invoiceId: string
  businessId: string
  publicId: string
}

/**
 * Pure builder for the PaymentIntent behind the embedded Payment Element.
 * The amount is re-derived from the server-loaded invoice row through the
 * shared amountToMinorUnits helper, and invoice/business/public id metadata
 * is stamped on the PaymentIntent (and therefore the Charge) so the webhook's
 * payment_intent.succeeded, charge.refunded and charge.dispute.created
 * handlers can all match it back to an invoice.
 */
export function buildPaymentIntentParams(
  input: PaymentIntentInput
): Stripe.PaymentIntentCreateParams {
  const amount = amountToMinorUnits(input.balanceDue, input.currency)

  return {
    amount,
    currency: input.currency.toLowerCase(),
    description: `Invoice ${input.invoiceNumber}`,
    // Lets the Stripe account's enabled payment methods (cards, wallets,
    // bank debits) surface in the Payment Element without Billr hard-coding
    // a list that would go stale.
    automatic_payment_methods: { enabled: true },
    metadata: {
      invoice_id: input.invoiceId,
      business_id: input.businessId,
      public_id: input.publicId,
    },
  }
}

/**
 * Minimal shape of an already-created PaymentIntent needed to decide what
 * to do with it on a repeat visit to the invoice page.
 */
export interface ExistingPaymentIntent {
  status: Stripe.PaymentIntent.Status
  amount: number
  currency: string
}

export type PaymentIntentDecision = 'reuse' | 'update' | 'create' | 'already_paid'

/**
 * True when an intent has already taken (or is in the middle of taking) the
 * payer's money, so offering them another way to pay this invoice would
 * risk a duplicate charge. `processing` counts: async methods land later,
 * and the invoice still reads balance_due > 0 until the webhook arrives.
 */
export function isIntentSettled(status: Stripe.PaymentIntent.Status): boolean {
  return status === 'succeeded' || status === 'processing' || status === 'requires_capture'
}

/**
 * Decides whether the invoice's existing PaymentIntent can be reused on a
 * repeat page load, rather than creating a fresh intent every time the
 * payment form mounts (which would litter the Stripe account with
 * abandoned intents and make the invoice row's stripe_payment_intent_id -
 * which refund/dispute matching depends on - churn constantly).
 *
 * The important case is `already_paid`: if the intent has already succeeded
 * or is still processing, the caller must refuse to hand out a client
 * secret at all. The webhook may not have landed yet, so the invoice can
 * still read balance_due > 0; without this check a payer who reloaded the
 * page after paying would be shown a live payment form and could be charged
 * a second time.
 */
export function decidePaymentIntentReuse(
  existing: ExistingPaymentIntent | null,
  desiredAmount: number,
  desiredCurrency: string
): PaymentIntentDecision {
  if (!existing) return 'create'

  if (isIntentSettled(existing.status)) return 'already_paid'

  switch (existing.status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      break
    default:
      // canceled, or any future status we do not understand: start fresh
      // rather than try to salvage it.
      return 'create'
  }

  // An intent's currency cannot be changed after creation, so a currency
  // change means a new intent.
  if (existing.currency.toLowerCase() !== desiredCurrency.toLowerCase()) return 'create'
  if (existing.amount !== desiredAmount) return 'update'
  return 'reuse'
}

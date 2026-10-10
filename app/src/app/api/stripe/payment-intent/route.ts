import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { z } from 'zod'
import { stripe } from '@/lib/stripe/client'
import { stripePaymentsConfigured } from '@/lib/stripe/config'
import { amountToMinorUnits } from '@/lib/stripe/money'
import { NOT_PAYABLE, loadPayableInvoice } from '@/lib/stripe/payable'
import { buildPaymentIntentParams, decidePaymentIntentReuse } from '@/lib/stripe/payment-intent'
import { RATE_LIMITS, clientIpFrom, consumeRateLimits, ipKey, rateLimitKey } from '@/lib/rate-limit'
import { createServiceClient } from '@/lib/supabase/service'

export const runtime = 'nodejs'

const bodySchema = z.object({ public_id: z.string().min(1).max(64) })

function unavailable(status: number, error = NOT_PAYABLE) {
  return NextResponse.json({ error, unavailable: true }, { status })
}

/**
 * Creates, or safely reuses, the PaymentIntent behind the card form on a
 * public invoice page. Charges land on this installation's own Stripe
 * account. Anything that cannot be resolved safely answers with
 * `unavailable: true`, and the page shows the invoice's payment instructions.
 */
export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'A public_id is required.' }, { status: 400 })
  }
  const { public_id } = parsed.data

  if (!stripePaymentsConfigured()) return unavailable(503)

  // Durable and layered: per invoice so one link cannot be hammered, per IP
  // so one source cannot sweep many links. Fails closed: this unauthenticated
  // endpoint creates Stripe objects.
  const ip = clientIpFrom(request.headers)
  const limited = await consumeRateLimits([
    { bucket: rateLimitKey('pay:intent', public_id), policy: RATE_LIMITS.publicDocument },
    { bucket: ipKey('pay:intent:ip', ip), policy: RATE_LIMITS.publicDocumentIp },
  ])
  if (!limited.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } },
    )
  }

  const service = createServiceClient()
  const payable = await loadPayableInvoice(service, public_id)
  if (!payable.ok) return unavailable(payable.status, payable.error)
  const { invoice } = payable
  const amount = amountToMinorUnits(invoice.balanceDue, invoice.currency)

  // Reuse the invoice's intent where possible, so repeat page loads do not
  // litter the account with abandoned intents and the id that refunds and
  // disputes match on stays stable. A remembered id that no longer exists
  // (keys switched to another account or mode) starts fresh; any other error
  // stops here, because guessing could create a second charge.
  let existing: Stripe.PaymentIntent | null = null
  if (invoice.stripe_payment_intent_id) {
    try {
      existing = await stripe.paymentIntents.retrieve(invoice.stripe_payment_intent_id)
    } catch (err) {
      if ((err as { code?: string }).code !== 'resource_missing') {
        console.error('stripe payment-intent: could not check the previous attempt', err)
        return unavailable(502, 'Could not check the previous payment attempt. Please try again.')
      }
    }
  }

  let decision = decidePaymentIntentReuse(existing, amount, invoice.currency)
  if (decision === 'already_paid' && existing?.status === 'succeeded') {
    // Once the webhook has booked that payment, a balance still showing is
    // new money owed (the total was raised afterwards), not the same charge
    // twice. Start a new attempt; the idempotency key names the old intent.
    const { data: booked, error } = await service
      .from('payments')
      .select('id')
      .eq('invoice_id', invoice.id)
      .eq('stripe_payment_id', existing.id)
      .maybeSingle()
    if (error) {
      console.error('stripe payment-intent: could not check the ledger', error.message)
      return unavailable(503, 'Could not check the previous payment attempt. Please try again.')
    }
    if (booked) decision = 'create'
  }
  if (decision === 'already_paid') {
    // The charge went through and the webhook has not landed yet. A fresh
    // form here is how a payer who reloads gets charged twice.
    return NextResponse.json(
      { error: 'This payment has already gone through. We are confirming it now.', status: 'processing' },
      { status: 409 },
    )
  }

  let intent: Stripe.PaymentIntent
  try {
    if (decision === 'reuse' && existing) {
      intent = existing
    } else if (decision === 'update' && existing) {
      intent = await stripe.paymentIntents.update(existing.id, { amount })
    } else {
      intent = await stripe.paymentIntents.create(
        buildPaymentIntentParams({
          currency: invoice.currency,
          invoiceNumber: invoice.invoice_number,
          balanceDue: invoice.balanceDue,
          invoiceId: invoice.id,
          businessId: invoice.business_id,
          publicId: public_id,
        }),
        {
          idempotencyKey: `billr:${invoice.id}:${existing?.id ?? 'initial'}:${invoice.currency}:${amount}`,
        },
      )
    }
  } catch (err) {
    console.error('stripe payment-intent: create or update failed', err)
    return unavailable(502)
  }

  if (!intent.client_secret) {
    console.error('stripe payment-intent: intent without a client secret', intent.id)
    return unavailable(502)
  }

  if (intent.id !== invoice.stripe_payment_intent_id) {
    // A new attempt clears the previous attempt's outcome. The id must be
    // saved before the payer can pay: refunds and disputes match on it. The
    // idempotency key above makes a retry return this same intent.
    const { error } = await service
      .from('invoices')
      .update({ stripe_payment_intent_id: intent.id, stripe_payment_status: null })
      .eq('id', invoice.id)
    if (error) {
      console.error('stripe payment-intent: could not save the attempt', error.message)
      return unavailable(503, 'Could not start the payment. Please try again.')
    }
  }

  return NextResponse.json({
    client_secret: intent.client_secret,
    publishable_key: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim(),
    amount,
    currency: invoice.currency,
  })
}

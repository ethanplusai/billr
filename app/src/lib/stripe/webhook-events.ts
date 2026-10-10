/**
 * The Stripe events Billr's webhook needs. Configure the endpoint at
 * /api/stripe/webhook to send exactly these.
 */
export const STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
] as const

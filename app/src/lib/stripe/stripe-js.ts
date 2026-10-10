import { loadStripe } from '@stripe/stripe-js/pure'
import type { Stripe } from '@stripe/stripe-js'

/**
 * Stripe.js must be loaded once per publishable key and the promise reused:
 * calling loadStripe on every render remounts the Elements iframe and wipes
 * whatever the payer typed.
 */
const cache = new Map<string, Promise<Stripe | null>>()

export function loadStripeJs(publishableKey: string): Promise<Stripe | null> {
  let promise = cache.get(publishableKey)
  if (!promise) {
    promise = loadStripe(publishableKey)
    cache.set(publishableKey, promise)
  }
  return promise
}

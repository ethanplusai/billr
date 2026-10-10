'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import type { StripeError } from '@stripe/stripe-js'
import { AlertCircle, CheckCircle2, CreditCard, Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { loadStripeJs } from '@/lib/stripe/stripe-js'

interface IntentResponse {
  client_secret: string
  publishable_key: string
  amount: number
  currency: string
}

type Phase =
  | { kind: 'loading' }
  /** Card payment cannot be offered; the invoice's own instructions apply. */
  | { kind: 'unavailable'; message: string }
  /** The charge already went through and we are waiting on the webhook. */
  | { kind: 'confirming' }
  | { kind: 'ready'; intent: IntentResponse }

const CARD_UNAVAILABLE =
  'Card payment is not available for this invoice right now. Use the payment instructions on the invoice, or contact the sender.'

interface InvoiceCheckoutProps {
  publicId: string
  balanceDue: number
  currency: string
  /** Called once the webhook has flipped the invoice to paid. */
  onConfirmed?: () => void
}

/**
 * Card payment for the public invoice page, on the Stripe account this
 * installation is configured with. Card details go straight from the browser
 * to Stripe; Billr never sees them.
 */
export function InvoiceCheckout({ publicId, balanceDue, currency, onConfirmed }: InvoiceCheckoutProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function createIntent() {
      try {
        const res = await fetch('/api/stripe/payment-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ public_id: publicId }),
        })
        const data = await res.json().catch(() => null)
        if (cancelled) return
        if (res.ok && data?.client_secret) {
          setPhase({ kind: 'ready', intent: data as IntentResponse })
          return
        }
        // Paid already, webhook not landed yet: a live form here is how
        // double charges happen.
        if (res.status === 409 && data?.status === 'processing') {
          setPhase({ kind: 'confirming' })
          return
        }
        setPhase({
          kind: 'unavailable',
          message: typeof data?.error === 'string' ? data.error : CARD_UNAVAILABLE,
        })
      } catch {
        if (!cancelled) setPhase({ kind: 'unavailable', message: CARD_UNAVAILABLE })
      }
    }

    createIntent()
    return () => {
      cancelled = true
    }
  }, [publicId])

  const stripePromise = useMemo(
    () => (phase.kind === 'ready' ? loadStripeJs(phase.intent.publishable_key) : null),
    [phase],
  )

  if (phase.kind === 'loading') {
    return (
      <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the secure payment form
      </div>
    )
  }

  if (phase.kind === 'confirming') {
    return <ConfirmingNotice publicId={publicId} onConfirmed={onConfirmed} />
  }

  if (phase.kind === 'unavailable') {
    return <p className="text-sm text-muted-foreground">{phase.message}</p>
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: phase.intent.client_secret,
        appearance: { theme: 'stripe', variables: { borderRadius: '8px' } },
      }}
    >
      <CheckoutForm
        publicId={publicId}
        balanceDue={balanceDue}
        currency={currency}
        onConfirmed={onConfirmed}
      />
    </Elements>
  )
}

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
}

function CheckoutForm({
  publicId,
  balanceDue,
  currency,
  onConfirmed,
}: InvoiceCheckoutProps) {
  const stripe = useStripe()
  const elements = useElements()
  const [ready, setReady] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [succeeded, setSucceeded] = useState(false)
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null)
  const [elementFailed, setElementFailed] = useState(false)

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (!stripe || !elements || submitting) return

      setSubmitting(true)
      setError(null)

      const result = await stripe
        .confirmPayment({
          elements,
          // Cards and 3D Secure complete in place (Stripe shows the
          // authentication step in a modal). Only payment methods that
          // genuinely require leaving the page will use return_url, and they
          // come back to the same invoice with the paid banner.
          redirect: 'if_required',
          confirmParams: {
            return_url: `${window.location.origin}/i/${publicId}?paid=1`,
          },
        })
        .catch((err: unknown) => {
          // confirmPayment rejects only on a genuine network/runtime fault.
          return { error: { type: 'api_connection_error', message: String(err) } as StripeError }
        })

      if (result.error) {
        setSubmitting(false)
        setError(describeStripeError(result.error))
        return
      }

      const status = result.paymentIntent?.status
      if (status === 'succeeded' || status === 'processing' || status === 'requires_capture') {
        // The webhook is the source of truth. Never mark the invoice paid
        // from here: show an optimistic state and let reconciliation confirm.
        setSucceeded(true)
        setSubmitting(false)
        return
      }

      setSubmitting(false)
      setError({
        message: 'That payment was not completed. Please try again or use a different card.',
        retryable: true,
      })
    },
    [stripe, elements, submitting, publicId]
  )

  if (succeeded) {
    return <ConfirmingNotice publicId={publicId} onConfirmed={onConfirmed} />
  }

  if (elementFailed) {
    return <p className="text-sm text-muted-foreground">{CARD_UNAVAILABLE}</p>
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement
        onReady={() => setReady(true)}
        onLoadError={() => setElementFailed(true)}
        options={{ layout: 'tabs' }}
      />

      {error && (
        <div className="flex items-start gap-3 rounded-lg bg-red-50 p-3 text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm">{error.message}</p>
            {!error.retryable && (
              <button
                type="button"
                className="text-sm font-medium underline"
                onClick={() => window.location.reload()}
              >
                Reload and try again
              </button>
            )}
          </div>
        </div>
      )}

      <Button type="submit" size="lg" className="w-full" disabled={!stripe || !ready || submitting}>
        {submitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Processing payment
          </>
        ) : (
          <>
            <CreditCard className="mr-2 h-4 w-4" />
            Pay{' '}
            {formatAmount(balanceDue, currency)}
          </>
        )}
      </Button>

      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Payments are processed by Stripe. Billr never sees your card details.
      </p>
    </form>
  )
}

/**
 * Maps a Stripe.js error into copy the payer can act on. Card declines,
 * validation problems and connectivity failures need different responses,
 * and Stripe's own decline messages are already payer-appropriate.
 */
function describeStripeError(error: StripeError): { message: string; retryable: boolean } {
  switch (error.type) {
    case 'card_error':
      return {
        message:
          error.message ||
          'Your card was declined. Please check the details or try a different card.',
        retryable: true,
      }
    case 'validation_error':
      return { message: error.message || 'Please check the payment details.', retryable: true }
    case 'api_connection_error':
      return {
        message: 'We could not reach Stripe. Check your connection and try again.',
        retryable: true,
      }
    default:
      return {
        message: error.message || 'Something went wrong taking that payment.',
        retryable: false,
      }
  }
}

/**
 * Optimistic post-charge state. The money has moved but Billr will not mark
 * the invoice paid until the webhook says so, so this polls the public
 * invoice until reconciliation lands rather than asserting a paid state the
 * ledger has not recorded.
 */
function ConfirmingNotice({
  publicId,
  onConfirmed,
}: {
  publicId: string
  onConfirmed?: () => void
}) {
  const [confirmed, setConfirmed] = useState(false)
  const onConfirmedRef = useRef(onConfirmed)
  onConfirmedRef.current = onConfirmed

  useEffect(() => {
    let cancelled = false
    let attempts = 0

    async function poll() {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      while (!cancelled && attempts < 20) {
        attempts += 1
        await new Promise((resolve) => setTimeout(resolve, 3000))
        if (cancelled) return

        const { data } = await supabase.rpc('get_public_invoice', { p_public_id: publicId })
        const status = (data as { invoice?: { status?: string } } | null)?.invoice?.status
        if (status === 'paid') {
          if (!cancelled) {
            setConfirmed(true)
            onConfirmedRef.current?.()
          }
          return
        }
      }
    }

    poll()
    return () => {
      cancelled = true
    }
  }, [publicId])

  if (confirmed) {
    return (
      <div className="flex items-start gap-3 rounded-lg bg-green-50 p-4 text-green-800">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="font-medium">Payment confirmed</p>
          <p className="text-sm">This invoice is now marked as paid. Thank you.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-3 rounded-lg bg-green-50 p-4 text-green-800">
      <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin" />
      <div>
        <p className="font-medium">Payment received, confirming now</p>
        <p className="text-sm">
          Your card has been charged. We are waiting on Stripe to confirm, which usually takes a
          few seconds. You can safely close this page.
        </p>
      </div>
    </div>
  )
}

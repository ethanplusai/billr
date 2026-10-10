'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { getStripeSetupAction, type StripeSetupView } from '@/lib/actions/stripe-setup'
import { STRIPE_WEBHOOK_EVENTS } from '@/lib/stripe/webhook-events'

/**
 * Card payments run on the Stripe account whose keys this installation is
 * configured with. This panel says whether they are on and, if not, exactly
 * what to set. It never shows a key value.
 */
export function PaymentsPanel() {
  const [setup, setSetup] = useState<StripeSetupView | null | undefined>(undefined)

  useEffect(() => {
    let active = true
    getStripeSetupAction()
      .then((value) => {
        if (active) setSetup(value)
      })
      .catch(() => {
        if (active) setSetup(null)
      })
    return () => {
      active = false
    }
  }, [])

  if (setup === undefined) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (setup === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not read the payment settings. Reload the page to try again.
      </p>
    )
  }

  const forwardTo = setup.webhookUrl.replace(/^https?:\/\//, '')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Card payments</CardTitle>
        <CardDescription>
          Clients pay invoices by card on the invoice page. The money goes to the Stripe
          account whose keys this Billr is configured with, and every business here uses
          that same account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {setup.configured ? (
          <div className="flex items-start gap-3 rounded-lg bg-green-50 p-4 text-green-800">
            <CheckCircle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">Card payments are on</p>
              <p>
                {setup.mode === 'test'
                  ? 'Test mode: use Stripe test cards. No real money moves.'
                  : 'Live mode: clients pay real money into your Stripe account.'}
              </p>
              <p>
                Webhook endpoint: <code className="break-all">{setup.webhookUrl}</code>
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-3 rounded-lg bg-amber-50 p-4 text-amber-900">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">Card payments are off</p>
                <p>{setup.problem ?? `Not set: ${setup.missing.join(', ')}.`}</p>
              </div>
            </div>
            <ol className="list-decimal space-y-3 pl-5">
              <li>
                In the Stripe Dashboard, open <strong>Developers</strong>, then{' '}
                <strong>API keys</strong>. Copy the publishable key (<code>pk_...</code>) and
                the secret key (<code>sk_...</code>). Start with test keys.
              </li>
              <li>
                Open <strong>Developers</strong>, then <strong>Webhooks</strong>, and add an
                endpoint at <code className="break-all">{setup.webhookUrl}</code> that sends{' '}
                {STRIPE_WEBHOOK_EVENTS.map((type, index) => (
                  <span key={type}>
                    {index > 0 ? ', ' : ''}
                    <code>{type}</code>
                  </span>
                ))}
                . Copy its signing secret (<code>whsec_...</code>). Running Billr on your own
                computer? <code>stripe listen --forward-to {forwardTo}</code> prints a signing
                secret to use instead.
              </li>
              <li>
                Set <code>STRIPE_SECRET_KEY</code>, <code>NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code>{' '}
                and <code>STRIPE_WEBHOOK_SECRET</code> in <code>app/.env.local</code> (or your
                server&apos;s environment) and restart Billr. Rebuild a Docker image: the
                publishable key is compiled into the browser code.
              </li>
            </ol>
          </>
        )}
        <p className="text-muted-foreground">
          Without card payments you can still record payments by hand on any invoice.
        </p>
      </CardContent>
    </Card>
  )
}

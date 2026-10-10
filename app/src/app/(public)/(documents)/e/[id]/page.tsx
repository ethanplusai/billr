'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { format } from 'date-fns'
import { Check, X, Loader2, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { estimateStatusColors } from '@/types'
import type { Estimate, EstimateLineItem, Business, Client } from '@/types'

import { toast } from 'sonner'
import { parseDay } from '@/lib/dates'

type PublicEstimate = Estimate & {
  line_items: EstimateLineItem[]
  business_snapshot: Business | null
  client_snapshot: Client | null
}

export default function PublicEstimatePage() {
  const params = useParams()
  const publicId = params.id as string
  const [estimate, setEstimate] = useState<PublicEstimate | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isResponding, setIsResponding] = useState(false)
  const [responseNotice, setResponseNotice] = useState<string | null>(null)

  useEffect(() => {
    async function fetchEstimate() {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      // Public access goes through a SECURITY DEFINER function keyed on public_id;
      // direct table selects are blocked for anonymous users.
      const { data } = await supabase.rpc('get_public_estimate', { p_public_id: publicId })
      const payload = data as { estimate: PublicEstimate; line_items: PublicEstimate['line_items'] } | null

      if (payload?.estimate) {
        setEstimate({ ...payload.estimate, line_items: payload.line_items })
      }
      setIsLoading(false)
    }

    fetchEstimate()
  }, [publicId])

  const formatCurrency = (amount: number, currency = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  }

  const handleRespond = async (response: 'accepted' | 'declined') => {
    if (!estimate) return
    setIsResponding(true)

    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()
    // Accept/decline flows through a SECURITY DEFINER function; only estimates
    // in 'sent'/'viewed' status can be responded to.
    const { data: ok, error } = await supabase.rpc('respond_to_estimate', {
      p_public_id: publicId,
      p_response: response,
    })

    if (error || !ok) {
      setResponseNotice('This estimate can no longer be responded to.')
    } else {
      setEstimate(prev => prev ? { ...prev, status: response } : null)
      toast.success(`Estimate ${response}`)
    }
    setIsResponding(false)
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!estimate) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 text-center">
            <h1 className="text-xl font-semibold">Estimate Not Found</h1>
            <p className="mt-2 text-muted-foreground">
              This estimate doesn&#39;t exist or has been removed.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const business = estimate.business_snapshot as Business | null
  const client = estimate.client_snapshot as Client | null
  const canRespond = ['sent', 'viewed'].includes(estimate.status)

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-3xl p-4 py-8 sm:p-6 md:py-12">
        {/* Response Status Bar */}
        {estimate.status === 'accepted' || estimate.status === 'converted' ? (
          <div className="mb-6 rounded-lg bg-green-50 p-4 text-center">
            <p className="font-medium text-green-800">
              ✓ This estimate has been accepted
            </p>
          </div>
        ) : estimate.status === 'declined' ? (
          <div className="mb-6 rounded-lg bg-red-50 p-4 text-center">
            <p className="font-medium text-red-800">
              This estimate has been declined
            </p>
          </div>
        ) : estimate.status === 'expired' ? (
          <div className="mb-6 rounded-lg bg-muted p-4 text-center">
            <p className="font-medium text-muted-foreground">
              This estimate has expired
            </p>
          </div>
        ) : canRespond ? (
          <Card className="no-print mb-6">
            <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Estimate Total</p>
                <p className="text-2xl font-bold">
                  {formatCurrency(estimate.total, estimate.currency)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="lg"
                  onClick={() => handleRespond('accepted')}
                  disabled={isResponding}
                >
                  {isResponding ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-2 h-4 w-4" />
                  )}
                  Accept
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => handleRespond('declined')}
                  disabled={isResponding}
                >
                  <X className="mr-2 h-4 w-4" />
                  Decline
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {responseNotice && (
          <div className="mb-6 rounded-lg bg-blue-50 p-4 text-center">
            <p className="font-medium text-blue-800">{responseNotice}</p>
          </div>
        )}

        {/* Print */}
        <div className="no-print mb-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="mr-2 h-4 w-4" />
            Print / Save as PDF
          </Button>
        </div>

        {/* Estimate Document */}
        <Card className="overflow-hidden">
          <CardContent className="p-8 sm:p-12">
            {/* Header */}
            <div className="flex flex-col gap-6 sm:flex-row sm:justify-between">
              <div>
                {business?.logo_url && (
                  <img
                    src={business.logo_url}
                    alt={business.name || 'Business'}
                    className="mb-4 h-12 w-auto"
                  />
                )}
                <h2 className="text-xl font-bold">{business?.name}</h2>
                {business?.address_line1 && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {business.address_line1}
                    {business.address_line2 && <><br />{business.address_line2}</>}
                    <br />
                    {[business.city, business.state, business.postal_code]
                      .filter(Boolean)
                      .join(', ')}
                    {business.country && <><br />{business.country}</>}
                  </p>
                )}
                {business?.email && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {business.email}
                  </p>
                )}
              </div>
              <div className="sm:text-right">
                <div className="flex items-center gap-2 sm:justify-end">
                  <h1 className="text-3xl font-bold">Estimate</h1>
                  <Badge
                    variant="secondary"
                    className={estimateStatusColors[estimate.status]}
                  >
                    {estimate.status}
                  </Badge>
                </div>
                <p className="mt-2 text-lg font-medium text-muted-foreground">
                  {estimate.estimate_number}
                </p>
              </div>
            </div>

            <div className="mt-8 grid gap-8 sm:grid-cols-2">
              {/* Prepared For */}
              <div>
                <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                  Prepared For
                </p>
                <p className="mt-2 font-semibold">{client?.name}</p>
                {client?.email && (
                  <p className="text-sm text-muted-foreground">{client.email}</p>
                )}
                {client?.address_line1 && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {client.address_line1}
                    <br />
                    {[client.city, client.state, client.postal_code]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                )}
              </div>

              {/* Estimate Details */}
              <div className="space-y-3 sm:text-right">
                <div>
                  <p className="text-sm text-muted-foreground">Date</p>
                  <p className="font-medium">
                    {format(parseDay(estimate.issue_date), 'MMMM d, yyyy')}
                  </p>
                </div>
                {estimate.expiry_date && (
                  <div>
                    <p className="text-sm text-muted-foreground">Valid Until</p>
                    <p className="font-medium">
                      {format(parseDay(estimate.expiry_date), 'MMMM d, yyyy')}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Line Items */}
            <div className="mt-10">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="pb-3 text-left text-sm font-medium text-muted-foreground">
                      Description
                    </th>
                    <th className="pb-3 text-right text-sm font-medium text-muted-foreground">
                      Qty
                    </th>
                    <th className="pb-3 text-right text-sm font-medium text-muted-foreground">
                      Rate
                    </th>
                    <th className="pb-3 text-right text-sm font-medium text-muted-foreground">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {estimate.line_items.map((item) => (
                    <tr key={item.id} className="border-b border-border/30">
                      <td className="py-4">{item.description}</td>
                      <td className="py-4 text-right tabular-nums">
                        {item.quantity}
                      </td>
                      <td className="py-4 text-right tabular-nums">
                        {formatCurrency(item.rate, estimate.currency)}
                      </td>
                      <td className="py-4 text-right tabular-nums font-medium">
                        {formatCurrency(item.amount, estimate.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="mt-8 flex justify-end">
              <div className="w-72 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums">
                    {formatCurrency(estimate.subtotal, estimate.currency)}
                  </span>
                </div>
                {estimate.discount_amount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Discount</span>
                    <span className="tabular-nums text-green-600">
                      -{formatCurrency(estimate.discount_amount, estimate.currency)}
                    </span>
                  </div>
                )}
                {estimate.tax_amount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Tax ({estimate.tax_rate}%)
                    </span>
                    <span className="tabular-nums">
                      {formatCurrency(estimate.tax_amount, estimate.currency)}
                    </span>
                  </div>
                )}
                {estimate.shipping_amount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Shipping</span>
                    <span className="tabular-nums">
                      {formatCurrency(estimate.shipping_amount, estimate.currency)}
                    </span>
                  </div>
                )}
                <Separator className="my-3" />
                <div className="flex justify-between text-xl font-bold">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatCurrency(estimate.total, estimate.currency)}
                  </span>
                </div>
              </div>
            </div>

            {/* Notes */}
            {estimate.notes && (
              <div className="mt-10 rounded-lg bg-muted/50 p-4">
                <p className="text-sm font-medium text-muted-foreground">Notes</p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{estimate.notes}</p>
              </div>
            )}

            {/* Terms */}
            {estimate.terms && (
              <div className="mt-4 rounded-lg bg-muted/50 p-4">
                <p className="text-sm font-medium text-muted-foreground">
                  Terms & Conditions
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{estimate.terms}</p>
              </div>
            )}
          </CardContent>

          {/* Footer */}
          <div className="border-t bg-muted/30 p-4 text-center">
            <p className="text-sm text-muted-foreground">
              Powered by{' '}
              <a
                href="/"
                target="_blank"
                className="font-medium text-foreground hover:text-primary"
              >
                Billr
              </a>
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}

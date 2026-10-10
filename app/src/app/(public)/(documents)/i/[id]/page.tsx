'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { format } from 'date-fns'
import { Download, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { InvoiceCheckout } from '@/components/payments/invoice-checkout'
import { invoiceStatusColors } from '@/types'
import type { Invoice, InvoiceLineItem, Business, Client } from '@/types'

import { parseDay } from '@/lib/dates'

type PublicInvoice = Invoice & {
  line_items: InvoiceLineItem[]
  business_snapshot: Business | null
  client_snapshot: Client | null
}

export default function PublicInvoicePage() {
  return (
    <Suspense>
      <PublicInvoicePageInner />
    </Suspense>
  )
}

function PublicInvoicePageInner() {
  const params = useParams()
  const searchParams = useSearchParams()
  const publicId = params.id as string
  const justPaid = searchParams.get('paid') === '1'
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null)
  const [paymentsEnabled, setPaymentsEnabled] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const fetchInvoice = useCallback(
    async function fetchInvoice() {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      // Public access goes through a SECURITY DEFINER function keyed on public_id;
      // direct table selects are blocked for anonymous users. View recording happens inside it.
      const { data } = await supabase.rpc('get_public_invoice', { p_public_id: publicId })
      const payload = data as {
        invoice: PublicInvoice
        line_items: PublicInvoice['line_items']
      } | null

      if (payload?.invoice) {
        setInvoice({ ...payload.invoice, line_items: payload.line_items })
      }
      setIsLoading(false)
    },
    [publicId]
  )

  useEffect(() => {
    fetchInvoice()
  }, [fetchInvoice])

  // Card payment is an installation setting, not a property of the invoice.
  useEffect(() => {
    let active = true
    fetch('/api/stripe/config')
      .then((response) => (response.ok ? response.json() : { available: false }))
      .then((data) => {
        if (active) setPaymentsEnabled(data.available === true)
      })
      .catch(() => {
        if (active) setPaymentsEnabled(false)
      })
    return () => {
      active = false
    }
  }, [])

  const formatCurrency = (amount: number, currency = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 text-center">
            <h1 className="text-xl font-semibold">Invoice Not Found</h1>
            <p className="mt-2 text-muted-foreground">
              This invoice does not exist or has been removed.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const business = invoice.business_snapshot as Business | null
  const client = invoice.client_snapshot as Client | null

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-3xl p-4 py-8 sm:p-6 md:py-12">
        {/* Payment Status Bar */}
        {invoice.status === 'paid' ? (
          <div className="no-print mb-6 rounded-lg bg-green-50 p-4 text-center">
            <p className="font-medium text-green-800">
              ✓ This invoice has been paid
            </p>
          </div>
        ) : justPaid ? (
          <div className="no-print mb-6 rounded-lg bg-green-50 p-4 text-center">
            <p className="font-medium text-green-800">
              ✓ Payment received. It may take a minute to reflect on this page.
            </p>
          </div>
        ) : invoice.balance_due > 0 ? (
          <Card className="no-print mb-6">
            <CardContent className="space-y-5 p-4 sm:p-6">
              <div>
                <p className="text-sm text-muted-foreground">Amount Due</p>
                <p className="text-2xl font-bold">
                  {formatCurrency(invoice.balance_due, invoice.currency)}
                </p>
              </div>
              {paymentsEnabled ? (
                /* Card payment through Stripe's Payment Element, on this page. */
                <InvoiceCheckout
                  publicId={publicId}
                  balanceDue={invoice.balance_due}
                  currency={invoice.currency}
                  onConfirmed={fetchInvoice}
                />
              ) : invoice.payment_instructions ? (
                /* Card payments are not set up on this installation, so the invoice's own instructions are the way to pay. */
                <p className="whitespace-pre-line text-sm text-muted-foreground">
                  {invoice.payment_instructions}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Contact the sender to arrange payment.
                </p>
              )}
            </CardContent>
          </Card>
        ) : null}

        {/* Download / Print */}
        <div className="no-print mb-4 flex justify-end gap-2">
          <Button size="sm" asChild>
            <a href={`/api/public/invoices/${publicId}/pdf`} download>
              <Download className="mr-2 h-4 w-4" />
              Download PDF
            </a>
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="mr-2 h-4 w-4" />
            Print
          </Button>
        </div>

        {/* Invoice Document */}
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
                  <h1 className="text-3xl font-bold">Invoice</h1>
                  <Badge
                    variant="secondary"
                    className={invoiceStatusColors[invoice.status]}
                  >
                    {invoice.status}
                  </Badge>
                </div>
                <p className="mt-2 text-lg font-medium text-muted-foreground">
                  {invoice.invoice_number}
                </p>
              </div>
            </div>

            <div className="mt-8 grid gap-8 sm:grid-cols-2">
              {/* Bill To */}
              <div>
                <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                  Bill To
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

              {/* Invoice Details */}
              <div className="space-y-3 sm:text-right">
                <div>
                  <p className="text-sm text-muted-foreground">Issue Date</p>
                  <p className="font-medium">
                    {format(parseDay(invoice.issue_date), 'MMMM d, yyyy')}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Due Date</p>
                  <p className="font-medium">
                    {format(parseDay(invoice.due_date), 'MMMM d, yyyy')}
                  </p>
                </div>
                {invoice.po_number && (
                  <div>
                    <p className="text-sm text-muted-foreground">PO Number</p>
                    <p className="font-medium">{invoice.po_number}</p>
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
                  {invoice.line_items.map((item) => (
                    <tr key={item.id} className="border-b border-border/30">
                      <td className="py-4">{item.description}</td>
                      <td className="py-4 text-right tabular-nums">
                        {item.quantity}
                      </td>
                      <td className="py-4 text-right tabular-nums">
                        {formatCurrency(item.rate, invoice.currency)}
                      </td>
                      <td className="py-4 text-right tabular-nums font-medium">
                        {formatCurrency(item.amount, invoice.currency)}
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
                    {formatCurrency(invoice.subtotal, invoice.currency)}
                  </span>
                </div>
                {invoice.discount_amount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Discount</span>
                    <span className="tabular-nums text-green-600">
                      -{formatCurrency(invoice.discount_amount, invoice.currency)}
                    </span>
                  </div>
                )}
                {invoice.tax_amount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Tax ({invoice.tax_rate}%)
                    </span>
                    <span className="tabular-nums">
                      {formatCurrency(invoice.tax_amount, invoice.currency)}
                    </span>
                  </div>
                )}
                {invoice.shipping_amount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Shipping</span>
                    <span className="tabular-nums">
                      {formatCurrency(invoice.shipping_amount, invoice.currency)}
                    </span>
                  </div>
                )}
                <Separator className="my-3" />
                <div className="flex justify-between text-xl font-bold">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatCurrency(invoice.total, invoice.currency)}
                  </span>
                </div>
                {invoice.amount_paid > 0 && (
                  <>
                    <div className="flex justify-between text-sm text-green-600">
                      <span>Amount Paid</span>
                      <span className="tabular-nums">
                        -{formatCurrency(invoice.amount_paid, invoice.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between font-bold">
                      <span>Balance Due</span>
                      <span className="tabular-nums">
                        {formatCurrency(invoice.balance_due, invoice.currency)}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Notes */}
            {invoice.notes && (
              <div className="mt-10 rounded-lg bg-muted/50 p-4">
                <p className="text-sm font-medium text-muted-foreground">Notes</p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{invoice.notes}</p>
              </div>
            )}

            {/* Terms */}
            {invoice.terms && (
              <div className="mt-4 rounded-lg bg-muted/50 p-4">
                <p className="text-sm font-medium text-muted-foreground">
                  Terms & Conditions
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{invoice.terms}</p>
              </div>
            )}

            {/* Payment Instructions */}
            {invoice.payment_instructions && (
              <div className="mt-4 rounded-lg bg-muted/50 p-4">
                <p className="text-sm font-medium text-muted-foreground">
                  Payment Instructions
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">
                  {invoice.payment_instructions}
                </p>
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

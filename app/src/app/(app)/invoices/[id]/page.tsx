'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { format } from 'date-fns'
import { toast } from 'sonner'
import {
  Edit,
  Send,
  ExternalLink,
  Copy,
  Files,
  Printer,
  DollarSign,
  MoreHorizontal,
  CheckCircle,
  FileText,
  Mail,
  MailCheck,
  Clock,
  Ban,
  PencilLine,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { SendInvoiceDialog } from '@/components/invoices/send-invoice-dialog'
import { PaymentCorrections, isStripeSourced } from '@/components/payments/payment-corrections'
import { invoiceStatusColors } from '@/types'
import type { Invoice, InvoiceLineItem, Client, Business, Payment } from '@/types'

import { parseDay } from '@/lib/dates'

type InvoiceWithRelations = Invoice & {
  client: Client
  line_items: InvoiceLineItem[]
  business_snapshot: Business | null
}

/**
 * One correction from payment_audit. before/after hold the
 * whole payment row at each point, which is what lets the activity feed say
 * what actually changed rather than just that something did.
 */
interface PaymentAuditEntry {
  id: string
  action: 'update' | 'void'
  created_at: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

/** Names the fields a correction touched, for the activity line. */
function changedFields(entry: PaymentAuditEntry): string {
  const labels: Record<string, string> = {
    payment_date: 'date',
    amount: 'amount',
    payment_method: 'method',
    reference_number: 'reference',
    notes: 'notes',
  }
  const changed = Object.keys(labels).filter(
    (key) => String(entry.before?.[key] ?? '') !== String(entry.after?.[key] ?? '')
  )
  return changed.map((key) => labels[key]).join(', ')
}

export default function InvoiceDetailPage() {
  const params = useParams()
  const router = useRouter()
  const invoiceId = params.id as string
  const [invoice, setInvoice] = useState<InvoiceWithRelations | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [sendDialogOpen, setSendDialogOpen] = useState(false)
  const [payments, setPayments] = useState<Payment[]>([])
  const [auditEntries, setAuditEntries] = useState<PaymentAuditEntry[]>([])

  useEffect(() => {
    setSendDialogOpen(new URLSearchParams(window.location.search).get('compose') === '1')
  }, [invoiceId])

  const loadInvoice = useCallback(async () => {
    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()

    // The payment ledger and its correction history come back with the invoice
    // so the money section and the activity feed never disagree with the totals
    // above them.
    const [{ data }, { data: paymentRows }, { data: auditRows }] = await Promise.all([
      supabase
        .from('invoices')
        .select(`
          *,
          client:clients(*),
          line_items:invoice_line_items(*)
        `)
        .eq('id', invoiceId)
        .single(),
      supabase
        .from('payments')
        .select('*')
        .eq('invoice_id', invoiceId)
        .order('payment_date', { ascending: false }),
      supabase
        .from('payment_audit')
        .select('id, action, created_at, before, after')
        .eq('invoice_id', invoiceId)
        .order('created_at', { ascending: false }),
    ])

    if (data) {
      setInvoice(data as InvoiceWithRelations)
    }
    setPayments((paymentRows ?? []) as Payment[])
    setAuditEntries((auditRows ?? []) as unknown as PaymentAuditEntry[])
    setIsLoading(false)
  }, [invoiceId])

  useEffect(() => {
    loadInvoice()
  }, [loadInvoice])

  const formatCurrency = (amount: number, currency = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  }

  const handleMarkAsPaid = () => {
    router.push(`/payments/new?invoice=${invoiceId}`)
  }

  const handleSendInvoice = () => {
    setSendDialogOpen(true)
  }

  const refreshInvoice = async () => {
    await loadInvoice()
  }

  // For an owner who shares the link or the PDF themselves: a draft has no
  // public page, so it has to be marked sent before the client can open it.
  const handleMarkAsSent = async () => {
    try {
      const { markInvoiceSentAction } = await import('@/lib/actions/invoices')
      const result = await markInvoiceSentAction(invoiceId)
      if (result.changed) toast.success('Invoice marked as sent')
      await loadInvoice()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not mark the invoice as sent')
    }
  }

  const copyPublicLink = () => {
    const url = `${window.location.origin}/i/${invoice?.public_id}`
    navigator.clipboard.writeText(url)
    toast.success('Link copied to clipboard')
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="p-6 lg:p-8">
        <EmptyState
          icon={FileText}
          title="Invoice not found"
          description="The invoice you're looking for doesn't exist."
          action={{ label: 'Back to Invoices', href: '/invoices' }}
        />
      </div>
    )
  }

  const business = invoice.business_snapshot as Business | null

  return (
    <div className="p-6 lg:p-8">
      <PageHeader title={invoice.invoice_number} className="no-print">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className={invoiceStatusColors[invoice.status]}
          >
            {invoice.status}
          </Badge>
          {/* Last online checkout attempt, recorded by the Stripe webhook.
              Not a ledger fact: a failed or expired attempt moved no money,
              so it never affects amount_paid, balance_due or status. */}
          {invoice.status !== 'paid' &&
            (invoice.stripe_payment_status === 'failed' ||
              invoice.stripe_payment_status === 'expired') && (
              <Badge variant="secondary" className="bg-red-100 text-red-700">
                {invoice.stripe_payment_status === 'failed'
                  ? 'Last payment attempt failed'
                  : 'Payment link expired'}
              </Badge>
            )}
        </div>
        <div className="flex items-center gap-2">
          {invoice.status !== 'paid' && invoice.status !== 'cancelled' && (
            <Button onClick={handleSendInvoice}>
              <Send className="mr-2 h-4 w-4" />
              {invoice.last_sent_at ? 'Resend Invoice' : 'Send Invoice'}
            </Button>
          )}
          {invoice.status !== 'paid' && invoice.status !== 'cancelled' && (
            <Button variant="outline" onClick={handleMarkAsPaid}>
              <CheckCircle className="mr-2 h-4 w-4" />
              Mark as Paid
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/invoices/${invoiceId}/edit`}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit
                </Link>
              </DropdownMenuItem>
              {invoice.status === 'draft' && (
                <DropdownMenuItem onClick={handleMarkAsSent}>
                  <MailCheck className="mr-2 h-4 w-4" />
                  Mark as Sent
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={copyPublicLink}>
                <Copy className="mr-2 h-4 w-4" />
                Copy Link
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/i/${invoice.public_id}`} target="_blank">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  View Public Page
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push(`/invoices/new?duplicate=${invoiceId}`)}
              >
                <Files className="mr-2 h-4 w-4" />
                Duplicate
              </DropdownMenuItem>
              {invoice.status !== 'paid' && invoice.status !== 'cancelled' && (
                <DropdownMenuItem asChild>
                  <Link href={`/payments/new?invoice=${invoiceId}`}>
                    <DollarSign className="mr-2 h-4 w-4" />
                    Record Payment
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href={`/api/invoices/${invoiceId}/pdf`} download>
                  <FileText className="mr-2 h-4 w-4" />
                  Download PDF
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.print()}>
                <Printer className="mr-2 h-4 w-4" />
                Print
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PageHeader>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className="space-y-6 lg:col-span-2">
          {/* Invoice Preview */}
          <Card>
            <CardContent className="p-8">
              {/* Header */}
              <div className="flex justify-between gap-4">
                <div className="min-w-0">
                  {business?.logo_url && (
                    <img
                      src={business.logo_url}
                      alt={business.name}
                      className="mb-4 h-12 w-auto"
                    />
                  )}
                  <h2 className="text-xl font-bold">{business?.name}</h2>
                  {business?.address_line1 && (
                    <p className="text-sm text-muted-foreground">
                      {business.address_line1}
                      {business.address_line2 && <br />}
                      {business.address_line2}
                      <br />
                      {[business.city, business.state, business.postal_code]
                        .filter(Boolean)
                        .join(', ')}
                      {business.country && <br />}
                      {business.country}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <h1 className="text-3xl font-bold text-primary">INVOICE</h1>
                  <p className="mt-2 text-lg font-medium">
                    {invoice.invoice_number}
                  </p>
                </div>
              </div>

              <div className="mt-8 grid gap-8 sm:grid-cols-2">
                {/* Bill To */}
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Bill To
                  </p>
                  <p className="mt-1 font-medium">{invoice.client.name}</p>
                  {invoice.client.email && (
                    <p className="text-sm text-muted-foreground">
                      {invoice.client.email}
                    </p>
                  )}
                  {invoice.client.address_line1 && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {invoice.client.address_line1}
                      <br />
                      {[
                        invoice.client.city,
                        invoice.client.state,
                        invoice.client.postal_code,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                  )}
                </div>

                {/* Invoice Details */}
                <div className="space-y-2 sm:text-right">
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
              <div className="mt-8">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="py-2 text-left text-sm font-medium text-muted-foreground">
                        Description
                      </th>
                      <th className="py-2 pl-3 text-right text-sm font-medium text-muted-foreground">
                        Qty
                      </th>
                      <th className="py-2 pl-3 text-right text-sm font-medium text-muted-foreground">
                        Rate
                      </th>
                      <th className="py-2 pl-3 text-right text-sm font-medium text-muted-foreground">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.line_items.map((item) => (
                      <tr key={item.id} className="border-b">
                        <td className="py-3">{item.description}</td>
                        <td className="py-3 pl-3 text-right tabular-nums">
                          {item.quantity}
                        </td>
                        <td className="py-3 pl-3 text-right tabular-nums">
                          {formatCurrency(item.rate, invoice.currency)}
                        </td>
                        <td className="py-3 pl-3 text-right tabular-nums">
                          {formatCurrency(item.amount, invoice.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="mt-6 flex justify-end">
                <div className="w-64 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="tabular-nums">
                      {formatCurrency(invoice.subtotal, invoice.currency)}
                    </span>
                  </div>
                  {invoice.discount_amount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Discount</span>
                      <span className="tabular-nums text-green-600">
                        -{formatCurrency(invoice.discount_amount, invoice.currency)}
                      </span>
                    </div>
                  )}
                  {invoice.tax_amount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Tax ({invoice.tax_rate}%)
                      </span>
                      <span className="tabular-nums">
                        {formatCurrency(invoice.tax_amount, invoice.currency)}
                      </span>
                    </div>
                  )}
                  {invoice.shipping_amount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Shipping</span>
                      <span className="tabular-nums">
                        {formatCurrency(invoice.shipping_amount, invoice.currency)}
                      </span>
                    </div>
                  )}
                  <Separator />
                  <div className="flex justify-between text-lg font-bold">
                    <span>Total</span>
                    <span className="tabular-nums">
                      {formatCurrency(invoice.total, invoice.currency)}
                    </span>
                  </div>
                  {invoice.amount_paid > 0 && (
                    <>
                      <div className="flex justify-between text-green-600">
                        <span>Paid</span>
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
                <div className="mt-8">
                  <p className="text-sm font-medium text-muted-foreground">
                    Notes
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    {invoice.notes}
                  </p>
                </div>
              )}

              {/* Terms */}
              {invoice.terms && (
                <div className="mt-4">
                  <p className="text-sm font-medium text-muted-foreground">
                    Terms & Conditions
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    {invoice.terms}
                  </p>
                </div>
              )}

              {/* Payment Instructions */}
              {invoice.payment_instructions && (
                <div className="mt-4">
                  <p className="text-sm font-medium text-muted-foreground">
                    Payment Instructions
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    {invoice.payment_instructions}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Payments */}
          {payments.length > 0 && (
            <Card className="no-print">
              <CardHeader>
                <CardTitle className="text-base">Payments</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {payments.map((payment) => (
                  <div
                    key={payment.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 last:border-b-0 last:pb-0"
                  >
                    <div className={payment.voided_at ? 'text-muted-foreground' : undefined}>
                      <p className={payment.voided_at ? 'font-medium line-through' : 'font-medium'}>
                        {formatCurrency(payment.amount, invoice.currency)} on{' '}
                        {format(parseDay(payment.payment_date), 'MMM d, yyyy')}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
                        <span>{payment.payment_method.replace(/_/g, ' ')}</span>
                        {payment.reference_number && <span>ref {payment.reference_number}</span>}
                        {isStripeSourced(payment) && <Badge variant="outline">Stripe</Badge>}
                        {payment.voided_at && (
                          <Badge variant="outline" className="border-red-200 text-red-700">
                            Voided
                          </Badge>
                        )}
                      </div>
                      {payment.voided_at && payment.void_reason && (
                        <p className="mt-1 text-xs text-muted-foreground">Voided: {payment.void_reason}</p>
                      )}
                    </div>
                    <PaymentCorrections
                      payment={payment}
                      onChanged={loadInvoice}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="no-print space-y-6">
          {/* Status Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3 text-sm">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium">Created</p>
                  <p className="text-muted-foreground">
                    {format(new Date(invoice.created_at), 'MMM d, yyyy h:mm a')}
                  </p>
                </div>
              </div>

              {invoice.last_sent_at && (
                <div className="flex items-center gap-3 text-sm">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100">
                    <Mail className="h-4 w-4 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-medium">Sent</p>
                    <p className="text-muted-foreground">
                      {format(
                        new Date(invoice.last_sent_at),
                        'MMM d, yyyy h:mm a'
                      )}
                    </p>
                  </div>
                </div>
              )}

              {invoice.last_viewed_at && (
                <div className="flex items-center gap-3 text-sm">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-100">
                    <Clock className="h-4 w-4 text-purple-600" />
                  </div>
                  <div>
                    <p className="font-medium">Viewed</p>
                    <p className="text-muted-foreground">
                      {format(
                        new Date(invoice.last_viewed_at),
                        'MMM d, yyyy h:mm a'
                      )}
                    </p>
                  </div>
                </div>
              )}

              {invoice.paid_at && (
                <div className="flex items-center gap-3 text-sm">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                  </div>
                  <div>
                    <p className="font-medium">Paid</p>
                    <p className="text-muted-foreground">
                      {format(parseDay(invoice.paid_at), 'MMM d, yyyy')}
                    </p>
                  </div>
                </div>
              )}

              {/* Payment corrections, from payment_audit. A money figure that
                  moved should never be a silent edit. */}
              {auditEntries.map((entry) => (
                <div key={entry.id} className="flex items-center gap-3 text-sm">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100">
                    {entry.action === 'void' ? (
                      <Ban className="h-4 w-4 text-amber-700" />
                    ) : (
                      <PencilLine className="h-4 w-4 text-amber-700" />
                    )}
                  </div>
                  <div>
                    <p className="font-medium">
                      {entry.action === 'void' ? 'Payment voided' : 'Payment updated'}
                    </p>
                    <p className="text-muted-foreground">
                      {format(new Date(entry.created_at), 'MMM d, yyyy h:mm a')}
                    </p>
                    <p className="text-muted-foreground">
                      {entry.action === 'void'
                        ? String(entry.after?.void_reason ?? 'No reason recorded')
                        : changedFields(entry) || 'No values changed'}
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Client Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Client</CardTitle>
            </CardHeader>
            <CardContent>
              <Link
                href={`/clients/${invoice.client_id}`}
                className="font-medium hover:text-primary"
              >
                {invoice.client.name}
              </Link>
              {invoice.client.email && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {invoice.client.email}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <SendInvoiceDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        invoiceId={invoiceId}
        invoiceNumber={invoice.invoice_number}
        defaultEmail={invoice.client.email}
        businessName={business?.name || 'Billr'}
        amountDue={invoice.balance_due ?? invoice.total}
        currency={invoice.currency}
        dueDate={invoice.due_date}
        primaryColor={business?.primary_color}
        onSent={refreshInvoice}
      />
    </div>
  )
}

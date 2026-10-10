'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { format } from 'date-fns'
import { toast } from 'sonner'
import {
  Edit,
  Send,
  MailCheck,
  ExternalLink,
  Copy,
  Printer,
  MoreHorizontal,
  FileText,
  ArrowRight,
  Handshake,
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
import { SendInvoiceDialog } from '@/components/invoices/send-invoice-dialog'
import { ConvertEstimateToEngagementDialog } from '@/components/engagements/convert-estimate-dialog'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { useBusiness } from '@/lib/hooks/use-business'
import { estimateStatusColors } from '@/types'
import type { Estimate, EstimateLineItem, Client, Business } from '@/types'

import { parseDay } from '@/lib/dates'

type EstimateWithRelations = Estimate & {
  client: Client
  line_items: EstimateLineItem[]
}

export default function EstimateDetailPage() {
  const params = useParams()
  const router = useRouter()
  const estimateId = params.id as string
  const { currentBusiness } = useBusiness()
  const [estimate, setEstimate] = useState<EstimateWithRelations | null>(null)
  const [business, setBusiness] = useState<Business | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isConverting, setIsConverting] = useState(false)
  const [sendDialogOpen, setSendDialogOpen] = useState(false)
  const [engagementDialogOpen, setEngagementDialogOpen] = useState(false)
  useEffect(() => {
    setSendDialogOpen(new URLSearchParams(window.location.search).get('compose') === '1')
  }, [estimateId])

  useEffect(() => {
    async function fetchEstimate() {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      const { data } = await supabase
        .from('estimates')
        .select(`
          *,
          client:clients(*),
          line_items:estimate_line_items(*)
        `)
        .eq('id', estimateId)
        .single()

      if (data) {
        setEstimate(data as EstimateWithRelations)
        setBusiness(data.business_snapshot as Business | null)
      }
      setIsLoading(false)
    }

    fetchEstimate()
  }, [estimateId])

  const formatCurrency = (amount: number, currency = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  }

  const handleSendEstimate = () => setSendDialogOpen(true)

  // For an owner who shares the link themselves: a draft has no public page.
  const handleMarkAsSent = async () => {
    if (!estimate) return
    try {
      const { markEstimateSentAction } = await import('@/lib/actions/estimates')
      const result = await markEstimateSentAction(estimateId)
      setEstimate({ ...estimate, status: result.status })
      if (result.changed) toast.success('Estimate marked as sent')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not mark the estimate as sent')
    }
  }

  const handleConvertToInvoice = async () => {
    if (!estimate) return

    if (!currentBusiness) return

    setIsConverting(true)
    try {
      const { convertEstimateAction } = await import('@/lib/actions/estimates')
      const invoice = await convertEstimateAction(estimateId)
      toast.success('Estimate converted to invoice')
      router.push(`/invoices/${invoice.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to convert estimate')
      setIsConverting(false)
    }
  }

  const copyPublicLink = () => {
    const url = `${window.location.origin}/e/${estimate?.public_id}`
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

  if (!estimate) {
    return (
      <div className="p-6 lg:p-8">
        <EmptyState
          icon={FileText}
          title="Estimate not found"
          description="The estimate you're looking for doesn't exist."
          action={{ label: 'Back to Estimates', href: '/estimates' }}
        />
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader title={estimate.estimate_number} className="no-print">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className={estimateStatusColors[estimate.status]}
          >
            {estimate.status}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {estimate.status === 'draft' && (
            <Button onClick={handleSendEstimate}>
              <Send className="mr-2 h-4 w-4" />
              Send Estimate
            </Button>
          )}
          {estimate.status === 'accepted' && !estimate.converted_invoice_id && (
            <Button onClick={handleConvertToInvoice} disabled={isConverting}>
              <ArrowRight className="mr-2 h-4 w-4" />
              Convert to Invoice
            </Button>
          )}
          {/* The same quote, billed in parts instead of all at once. An
              estimate can become one or the other, never both, and the
              database refuses the second attempt whichever order they come
              in. */}
          {estimate.status === 'accepted' && !estimate.converted_invoice_id && (
            <Button
              variant="outline"
              onClick={() => setEngagementDialogOpen(true)}
              disabled={isConverting}
            >
              <Handshake className="mr-2 h-4 w-4" />
              Convert to Engagement
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
                <Link href={`/estimates/${estimateId}/edit`}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit
                </Link>
              </DropdownMenuItem>
              {estimate.status === 'draft' && (
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
                <Link href={`/e/${estimate.public_id}`} target="_blank">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  View Public Page
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => window.print()}>
                <Printer className="mr-2 h-4 w-4" />
                Print / Save as PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PageHeader>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className="space-y-6 lg:col-span-2">
          {/* Estimate Preview */}
          <Card>
            <CardContent className="p-8">
              {/* Header */}
              <div className="flex justify-between gap-4">
                <div className="min-w-0">
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
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <h1 className="text-3xl font-bold text-primary">ESTIMATE</h1>
                  <p className="mt-2 text-lg font-medium">
                    {estimate.estimate_number}
                  </p>
                </div>
              </div>

              <div className="mt-8 grid gap-8 sm:grid-cols-2">
                {/* Prepared For */}
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Prepared For
                  </p>
                  <p className="mt-1 font-medium">{estimate.client.name}</p>
                  {estimate.client.email && (
                    <p className="text-sm text-muted-foreground">
                      {estimate.client.email}
                    </p>
                  )}
                </div>

                {/* Estimate Details */}
                <div className="space-y-2 sm:text-right">
                  <div>
                    <p className="text-sm text-muted-foreground">Date</p>
                    <p className="font-medium">
                      {format(parseDay(estimate.issue_date), 'MMMM d, yyyy')}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Valid Until</p>
                    <p className="font-medium">
                      {format(parseDay(estimate.expiry_date as string), 'MMMM d, yyyy')}
                    </p>
                  </div>
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
                    {estimate.line_items.map((item) => (
                      <tr key={item.id} className="border-b">
                        <td className="py-3">{item.description}</td>
                        <td className="py-3 pl-3 text-right tabular-nums">
                          {item.quantity}
                        </td>
                        <td className="py-3 pl-3 text-right tabular-nums">
                          {formatCurrency(item.rate, estimate.currency)}
                        </td>
                        <td className="py-3 pl-3 text-right tabular-nums">
                          {formatCurrency(item.amount, estimate.currency)}
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
                      {formatCurrency(estimate.subtotal, estimate.currency)}
                    </span>
                  </div>
                  {estimate.discount_amount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Discount</span>
                      <span className="tabular-nums text-green-600">
                        -{formatCurrency(estimate.discount_amount, estimate.currency)}
                      </span>
                    </div>
                  )}
                  {estimate.tax_amount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Tax ({estimate.tax_rate}%)
                      </span>
                      <span className="tabular-nums">
                        {formatCurrency(estimate.tax_amount, estimate.currency)}
                      </span>
                    </div>
                  )}
                  <Separator />
                  <div className="flex justify-between text-lg font-bold">
                    <span>Total</span>
                    <span className="tabular-nums">
                      {formatCurrency(estimate.total, estimate.currency)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Notes */}
              {estimate.notes && (
                <div className="mt-8">
                  <p className="text-sm font-medium text-muted-foreground">
                    Notes
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    {estimate.notes}
                  </p>
                </div>
              )}

              {/* Terms */}
              {estimate.terms && (
                <div className="mt-4">
                  <p className="text-sm font-medium text-muted-foreground">
                    Terms & Conditions
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    {estimate.terms}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="no-print space-y-6">
          {/* Activity */}
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
                    {format(new Date(estimate.created_at), 'MMM d, yyyy h:mm a')}
                  </p>
                </div>
              </div>

            </CardContent>
          </Card>

          {/* Client Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Client</CardTitle>
            </CardHeader>
            <CardContent>
              <Link
                href={`/clients/${estimate.client_id}`}
                className="font-medium hover:text-primary"
              >
                {estimate.client.name}
              </Link>
              {estimate.client.email && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {estimate.client.email}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Converted Invoice */}
          {estimate.converted_invoice_id && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Converted to Invoice</CardTitle>
              </CardHeader>
              <CardContent>
                <Link
                  href={`/invoices/${estimate.converted_invoice_id}`}
                  className="font-medium text-primary hover:underline"
                >
                  View Invoice →
                </Link>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      <ConvertEstimateToEngagementDialog
        open={engagementDialogOpen}
        onOpenChange={setEngagementDialogOpen}
        estimateId={estimateId}
        total={estimate.total}
        currency={estimate.currency || 'USD'}
      />
      <SendInvoiceDialog kind="estimate" open={sendDialogOpen} onOpenChange={setSendDialogOpen}
        invoiceId={estimateId} invoiceNumber={estimate.estimate_number}
        defaultEmail={estimate.client.email} businessName={business?.name || 'Billr'}
        amountDue={estimate.total} currency={estimate.currency} dueDate={estimate.expiry_date || estimate.issue_date}
        onSent={() => setEstimate({ ...estimate, status: 'sent' })} />
    </div>
  )
}


'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { format } from 'date-fns'
import { toast } from 'sonner'
import {
  Mail,
  Phone,
  Globe,
  MapPin,
  Edit,
  FileText,
  Plus,
  Building2,
  DollarSign,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { paymentMethods } from '@/lib/constants'
import { invoiceStatusColors, estimateStatusColors } from '@/types'
import type { Client, Invoice, Estimate, Payment } from '@/types'

import { parseDay } from '@/lib/dates'

type PaymentWithInvoice = Payment & {
  invoice: { invoice_number: string } | null
}

export default function ClientDetailPage() {
  const params = useParams()
  const router = useRouter()
  const clientId = params.id as string
  const [client, setClient] = useState<Client | null>(null)
  const [financials, setFinancials] = useState({
    total_invoiced: 0,
    total_paid: 0,
    outstanding_balance: 0,
  })
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [payments, setPayments] = useState<PaymentWithInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    async function fetchClientData() {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      const { data: clientData } = await supabase
        .from('clients')
        .select('*')
        .eq('id', clientId)
        .single()

      if (clientData) {
        setClient(clientData)
      }

      // Computed from invoices by the client_financials view,
      // replacing the clients.total_* columns that nothing maintained.
      const { data: financialsData } = await supabase
        .from('client_financials')
        .select('total_invoiced, total_paid, outstanding_balance')
        .eq('client_id', clientId)
        .eq('currency', clientData?.currency || 'USD')
        .maybeSingle()

      if (financialsData) {
        setFinancials({ total_invoiced: financialsData.total_invoiced ?? 0, total_paid: financialsData.total_paid ?? 0, outstanding_balance: financialsData.outstanding_balance ?? 0 })
      }

      const { data: invoiceData } = await supabase
        .from('invoices')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })

      if (invoiceData) {
        setInvoices(invoiceData as Invoice[])
      }

      const { data: estimateData } = await supabase
        .from('estimates')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })

      if (estimateData) {
        setEstimates(estimateData as Estimate[])
      }

      // Voided payments are not money and are left out of every list by
      // default; the invoice page shows them, struck through.
      const { data: paymentData } = await supabase
        .from('payments')
        .select('*, invoice:invoices(invoice_number)')
        .eq('client_id', clientId)
        .is('voided_at', null)
        .order('payment_date', { ascending: false })

      if (paymentData) {
        setPayments(paymentData as PaymentWithInvoice[])
      }

      setIsLoading(false)
    }

    fetchClientData()
  }, [clientId])

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      const { deleteClientAction } = await import('@/lib/actions/clients')
      await deleteClientAction(clientId)
      toast.success('Client deleted')
      router.push('/clients')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete client')
      setIsDeleting(false)
    }
  }

  const formatCurrency = (amount: number, currency = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  }

  const paymentMethodLabel = (method: string) =>
    paymentMethods.find((m) => m.value === method)?.label || method

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!client) {
    return (
      <div className="p-6 lg:p-8">
        <EmptyState
          icon={Building2}
          title="Client not found"
          description="The client you're looking for doesn't exist or has been deleted."
          action={{ label: 'Back to Clients', href: '/clients' }}
        />
      </div>
    )
  }

  const address = [
    client.address_line1,
    client.address_line2,
    [client.city, client.state, client.postal_code].filter(Boolean).join(', '),
    client.country,
  ].filter(Boolean).join('\n')

  return (
    <div className="p-6 lg:p-8">
      <PageHeader title={client.name}>
        <Button
          variant="outline"
          className="text-destructive hover:text-destructive"
          onClick={() => setShowDeleteDialog(true)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>
        <Button variant="outline" asChild>
          <Link href={`/clients/${clientId}/edit`}>
            <Edit className="mr-2 h-4 w-4" />
            Edit
          </Link>
        </Button>
        <Button asChild>
          <Link href={`/invoices/new?client=${clientId}`}>
            <Plus className="mr-2 h-4 w-4" />
            New Invoice
          </Link>
        </Button>
      </PageHeader>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Left Column - Client Info */}
        <div className="space-y-6">
          {/* Contact Info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contact Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {client.email && (
                <div className="flex items-center gap-3">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <a
                    href={`mailto:${client.email}`}
                    className="text-sm hover:text-primary"
                  >
                    {client.email}
                  </a>
                </div>
              )}
              {client.phone && (
                <div className="flex items-center gap-3">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <a
                    href={`tel:${client.phone}`}
                    className="text-sm hover:text-primary"
                  >
                    {client.phone}
                  </a>
                </div>
              )}
              {client.website && (
                <div className="flex items-center gap-3">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <a
                    href={client.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm hover:text-primary"
                  >
                    {client.website}
                  </a>
                </div>
              )}
              {address && (
                <div className="flex gap-3">
                  <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="whitespace-pre-line text-sm">{address}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Billing Info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Billing Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Currency</span>
                <span className="font-medium">{client.currency}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Payment Terms</span>
                <span className="font-medium">{client.payment_terms} days</span>
              </div>
              {client.tax_id && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tax ID</span>
                  <span className="font-medium">{client.tax_id}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Stats */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total Invoiced</span>
                <span className="font-medium tabular-nums">
                  {formatCurrency(financials.total_invoiced, client.currency)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total Paid</span>
                <span className="font-medium tabular-nums text-green-600">
                  {formatCurrency(financials.total_paid, client.currency)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Outstanding ({client.currency} only)</span>
                <span className="font-medium tabular-nums text-amber-600">
                  {formatCurrency(financials.outstanding_balance, client.currency)}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Notes */}
          {client.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Internal Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{client.notes}</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column - Activity */}
        <div className="lg:col-span-2">
          <Tabs defaultValue="invoices">
            <TabsList>
              <TabsTrigger value="invoices">
                Invoices ({invoices.length})
              </TabsTrigger>
              <TabsTrigger value="estimates">
                Estimates ({estimates.length})
              </TabsTrigger>
              <TabsTrigger value="payments">
                Payments ({payments.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="invoices" className="mt-4">
              {invoices.length === 0 ? (
                <Card>
                  <CardContent className="py-12">
                    <EmptyState
                      icon={FileText}
                      title="No invoices yet"
                      description="Create your first invoice for this client"
                      action={{
                        label: 'Create Invoice',
                        href: `/invoices/new?client=${clientId}`,
                      }}
                    />
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <div className="divide-y">
                      {invoices.map((invoice) => (
                        <Link
                          key={invoice.id}
                          href={`/invoices/${invoice.id}`}
                          className="flex items-center justify-between p-4 transition-colors hover:bg-accent"
                        >
                          <div className="flex items-center gap-4">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                              <FileText className="h-5 w-5 text-muted-foreground" />
                            </div>
                            <div>
                              <p className="font-medium">{invoice.invoice_number}</p>
                              <p className="text-sm text-muted-foreground">
                                Due {format(parseDay(invoice.due_date), 'MMM d, yyyy')}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="font-medium tabular-nums">
                              {formatCurrency(invoice.total, invoice.currency)}
                            </span>
                            <Badge
                              variant="secondary"
                              className={invoiceStatusColors[invoice.status]}
                            >
                              {invoice.status}
                            </Badge>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="estimates" className="mt-4">
              {estimates.length === 0 ? (
                <Card>
                  <CardContent className="py-12">
                    <EmptyState
                      icon={FileText}
                      title="No estimates yet"
                      description="Create an estimate for this client"
                      action={{
                        label: 'Create Estimate',
                        href: `/estimates/new?client=${clientId}`,
                      }}
                    />
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <div className="divide-y">
                      {estimates.map((estimate) => (
                        <Link
                          key={estimate.id}
                          href={`/estimates/${estimate.id}`}
                          className="flex items-center justify-between p-4 transition-colors hover:bg-accent"
                        >
                          <div className="flex items-center gap-4">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                              <FileText className="h-5 w-5 text-muted-foreground" />
                            </div>
                            <div>
                              <p className="font-medium">{estimate.estimate_number}</p>
                              <p className="text-sm text-muted-foreground">
                                {estimate.expiry_date
                                  ? `Expires ${format(parseDay(estimate.expiry_date), 'MMM d, yyyy')}`
                                  : `Issued ${format(parseDay(estimate.issue_date), 'MMM d, yyyy')}`}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="font-medium tabular-nums">
                              {formatCurrency(estimate.total, estimate.currency)}
                            </span>
                            <Badge
                              variant="secondary"
                              className={estimateStatusColors[estimate.status]}
                            >
                              {estimate.status}
                            </Badge>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="payments" className="mt-4">
              {payments.length === 0 ? (
                <Card>
                  <CardContent className="py-12">
                    <EmptyState
                      icon={DollarSign}
                      title="No payments yet"
                      description="Payments will appear here when invoices are paid"
                    />
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <div className="divide-y">
                      {payments.map((payment) => (
                        <div
                          key={payment.id}
                          className="flex items-center justify-between p-4"
                        >
                          <div className="flex items-center gap-4">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
                              <DollarSign className="h-5 w-5 text-green-600" />
                            </div>
                            <div>
                              <p className="font-medium">
                                {paymentMethodLabel(payment.payment_method)}
                                {payment.invoice && ` · ${payment.invoice.invoice_number}`}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {format(parseDay(payment.payment_date), 'MMM d, yyyy')}
                                {payment.reference_number && ` · ${payment.reference_number}`}
                              </p>
                            </div>
                          </div>
                          <span className="font-medium tabular-nums text-green-600">
                            {formatCurrency(payment.amount, payment.currency)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Client</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{client.name}&quot;? Their invoices
              and payment history will be kept, but they will no longer appear
              in your client list.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

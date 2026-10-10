'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import {
  Plus,
  Search,
  DollarSign,
  CreditCard,
  TrendingUp,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { PaymentCorrections, isStripeSourced } from '@/components/payments/payment-corrections'
import { useBusiness } from '@/lib/hooks/use-business'
import { paymentMethods } from '@/lib/constants'
import type { Payment, Invoice, Client } from '@/types'

import { parseDay } from '@/lib/dates'

export default function PaymentsPage() {
  const { currentBusiness } = useBusiness()
  const [payments, setPayments] = useState<(Payment & { invoice: Invoice & { client: Client } })[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [methodFilter, setMethodFilter] = useState<string>('all')

  const fetchPayments = useCallback(async () => {
    if (!currentBusiness) return

    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()
    const { data } = await supabase
      .from('payments')
      .select('*, invoice:invoices(*, client:clients(*))')
      .eq('business_id', currentBusiness.id)
      .order('payment_date', { ascending: false })

    if (data) {
      setPayments(data as (Payment & { invoice: Invoice & { client: Client } })[])
    }
    setIsLoading(false)
  }, [currentBusiness])

  useEffect(() => {
    fetchPayments()
  }, [fetchPayments])

  const filteredPayments = payments.filter((payment) => {
    const matchesSearch =
      payment.invoice.invoice_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      payment.invoice.client.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      payment.reference_number?.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesMethod =
      methodFilter === 'all' || payment.payment_method === methodFilter
    return matchesSearch && matchesMethod
  })

  // A voided payment is not money. It stays on the list, struck through, but it
  // never counts towards a total here or in any report.
  const livePayments = filteredPayments.filter((p) => !p.voided_at)
  const totalReceived = livePayments.reduce((sum, p) => sum + p.amount, 0)
  const thisMonthPayments = livePayments.filter((p) => {
    const paymentDate = parseDay(p.payment_date)
    const now = new Date()
    return (
      paymentDate.getMonth() === now.getMonth() &&
      paymentDate.getFullYear() === now.getFullYear()
    )
  })
  const thisMonthTotal = thisMonthPayments.reduce((sum, p) => sum + p.amount, 0)

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currentBusiness?.default_currency || 'USD',
    }).format(amount)
  }

  const getPaymentMethodLabel = (method: string) => {
    return paymentMethods.find((m) => m.value === method)?.label || method
  }

  if (!currentBusiness) return null

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="Payments"
        description="View payment history and record payments"
      >
        <Button asChild>
          <Link href="/payments/new">
            <Plus className="mr-2 h-4 w-4" />
            Record Payment
          </Link>
        </Button>
      </PageHeader>

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
                <DollarSign className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Received</p>
                <p className="text-2xl font-bold tabular-nums">{formatCurrency(totalReceived)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                <TrendingUp className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">This Month</p>
                <p className="text-2xl font-bold tabular-nums">{formatCurrency(thisMonthTotal)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search payments..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={methodFilter} onValueChange={setMethodFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All methods" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Methods</SelectItem>
            {paymentMethods.map((method) => (
              <SelectItem key={method.value} value={method.value}>
                {method.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Payments List */}
      <div className="mt-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : filteredPayments.length === 0 ? (
          <Card>
            <CardContent className="py-12">
              <EmptyState
                icon={CreditCard}
                title={searchQuery || methodFilter !== 'all' ? 'No payments found' : 'No payments yet'}
                description={
                  searchQuery || methodFilter !== 'all'
                    ? 'Try adjusting your filters'
                    : 'Payments will appear here when invoices are paid'
                }
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-[170px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPayments.map((payment) => (
                    <TableRow key={payment.id} className={payment.voided_at ? 'text-muted-foreground' : undefined}>
                      <TableCell className={payment.voided_at ? 'font-medium line-through' : 'font-medium'}>
                        {format(parseDay(payment.payment_date), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/invoices/${payment.invoice_id}`}
                          className="font-medium hover:text-primary"
                        >
                          {payment.invoice.invoice_number}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/clients/${payment.invoice.client_id}`}
                          className="hover:text-primary"
                        >
                          {payment.invoice.client.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant="secondary">
                            {getPaymentMethodLabel(payment.payment_method)}
                          </Badge>
                          {isStripeSourced(payment) && payment.payment_method !== 'stripe' && (
                            <Badge variant="outline">Stripe</Badge>
                          )}
                          {payment.voided_at && (
                            <Badge variant="outline" className="border-red-200 text-red-700">
                              Voided
                            </Badge>
                          )}
                        </div>
                        {payment.voided_at && payment.void_reason && (
                          <p className="mt-1 text-xs text-muted-foreground">{payment.void_reason}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {payment.reference_number || 'None'}
                      </TableCell>
                      <TableCell
                        className={
                          payment.voided_at
                            ? 'text-right font-medium tabular-nums text-muted-foreground line-through'
                            : 'text-right font-medium tabular-nums text-green-600'
                        }
                      >
                        +{formatCurrency(payment.amount)}
                      </TableCell>
                      <TableCell>
                        <PaymentCorrections
                          payment={payment}
                          onChanged={fetchPayments}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}


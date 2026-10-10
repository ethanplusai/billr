'use client'

import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { format } from 'date-fns'
import { CalendarIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { Calendar } from '@/components/ui/calendar'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { paymentMethods } from '@/lib/constants'
import type { Invoice, Client } from '@/types'

const paymentSchema = z.object({
  invoice_id: z.string().min(1, 'Please select an invoice'),
  amount: z.coerce.number().min(0.01, 'Amount must be greater than 0'),
  payment_date: z.date(),
  payment_method: z.string().min(1, 'Please select a payment method'),
  reference_number: z.string().optional(),
  notes: z.string().optional(),
})

export type PaymentFormData = z.infer<typeof paymentSchema>

interface PaymentFormProps {
  invoices: (Invoice & { client: Client })[]
  onSubmit: (data: PaymentFormData) => Promise<void>
  onCancel: () => void
  defaultInvoiceId?: string
}

export function PaymentForm({
  invoices,
  onSubmit,
  onCancel,
  defaultInvoiceId,
}: PaymentFormProps) {
  const unpaidInvoices = invoices.filter(
    (inv) => inv.balance_due > 0 && inv.status !== 'cancelled'
  )

  const form = useForm<PaymentFormData>({
    resolver: zodResolver(paymentSchema) as Resolver<PaymentFormData>,
    defaultValues: {
      invoice_id: defaultInvoiceId || '',
      amount: 0,
      payment_date: new Date(),
      payment_method: '',
      reference_number: '',
      notes: '',
    },
  })

  const selectedInvoiceId = form.watch('invoice_id')
  const selectedInvoice = unpaidInvoices.find(
    (inv) => inv.id === selectedInvoiceId
  )

  const handleInvoiceChange = (invoiceId: string) => {
    const invoice = unpaidInvoices.find((inv) => inv.id === invoiceId)
    if (invoice) {
      form.setValue('invoice_id', invoiceId)
      form.setValue('amount', invoice.balance_due)
    }
  }

  const handleSubmit = async (data: PaymentFormData) => {
    await onSubmit(data)
  }

  const formatCurrency = (amount: number, currency = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <Card>
          <CardContent className="pt-6">
            <div className="grid gap-6 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="invoice_id"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Invoice</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={handleInvoiceChange}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select an invoice" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {unpaidInvoices.length === 0 ? (
                          <p className="p-4 text-center text-sm text-muted-foreground">
                            No unpaid invoices
                          </p>
                        ) : (
                          unpaidInvoices.map((invoice) => (
                            <SelectItem key={invoice.id} value={invoice.id}>
                              <div className="flex items-center justify-between gap-4">
                                <span>
                                  {invoice.invoice_number} - {invoice.client.name}
                                </span>
                                <span className="text-muted-foreground">
                                  {formatCurrency(invoice.balance_due, invoice.currency)} due
                                </span>
                              </div>
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {selectedInvoice && (
                <div className="rounded-lg bg-muted p-4 sm:col-span-2">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <p className="text-sm text-muted-foreground">Invoice Total</p>
                      <p className="font-medium tabular-nums">
                        {formatCurrency(selectedInvoice.total, selectedInvoice.currency)}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Already Paid</p>
                      <p className="font-medium tabular-nums text-green-600">
                        {formatCurrency(selectedInvoice.amount_paid, selectedInvoice.currency)}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Balance Due</p>
                      <p className="font-medium tabular-nums">
                        {formatCurrency(selectedInvoice.balance_due, selectedInvoice.currency)}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Payment Amount</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                          $
                        </span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0.01"
                          max={selectedInvoice?.balance_due}
                          placeholder="0.00"
                          className="pl-7"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    {selectedInvoice && field.value < selectedInvoice.balance_due && (
                      <FormDescription>
                        This is a partial payment
                      </FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="payment_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Payment Date</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            className={cn(
                              'w-full justify-start text-left font-normal',
                              !field.value && 'text-muted-foreground'
                            )}
                          >
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {field.value ? (
                              format(field.value, 'PPP')
                            ) : (
                              <span>Pick a date</span>
                            )}
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={field.value}
                          onSelect={field.onChange}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="payment_method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Payment Method</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select method" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {paymentMethods
                          .filter((m) => m.value !== 'stripe')
                          .map((method) => (
                            <SelectItem key={method.value} value={method.value}>
                              {method.label}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="reference_number"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reference Number (Optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Check #1234" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Notes (Optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Any additional notes about this payment"
                        rows={3}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Recording...' : 'Record Payment'}
          </Button>
        </div>
      </form>
    </Form>
  )
}


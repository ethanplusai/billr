'use client'

import { useEffect, useState } from 'react'
import { useForm, Controller, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { format, addDays } from 'date-fns'
import { CalendarIcon, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Calendar } from '@/components/ui/calendar'
import { LineItemsEditor } from './line-items-editor'
import {
  invoiceSchema,
  type InvoiceFormData,
  type LineItemFormData,
} from '@/lib/validations/invoice'
import {
  createEmptyLineItem,
  calculateInvoiceTotals,
  formatInvoiceNumber,
} from '@/lib/utils/invoice'
import { cn } from '@/lib/utils'
import type { Client, Business, Invoice, InvoiceLineItem } from '@/types'
import { parseDay, toISODate, todayISO } from '@/lib/dates'

interface InvoiceFormProps {
  invoice?: Invoice & { line_items: InvoiceLineItem[] }
  clients: Client[]
  business: Business
  onSubmit: (data: InvoiceFormData, status: 'draft' | 'sent') => Promise<void>
  onCancel: () => void
  defaultClientId?: string
  /**
   * Extra cards rendered under the line items, given the form state they need
   * to react to. The new invoice page uses it for the engagement picker, which
   * has to know which client and currency the form is currently on and has to
   * be able to write preview lines into it.
   */
  renderExtras?: (context: {
    clientId: string
    currency: string
    lineItems: LineItemFormData[]
    setLineItems: (items: LineItemFormData[]) => void
  }) => React.ReactNode
}

export function InvoiceForm({
  invoice,
  clients,
  business,
  onSubmit,
  onCancel,
  defaultClientId,
  renderExtras,
}: InvoiceFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitType, setSubmitType] = useState<'draft' | 'sent'>('draft')

  const defaultLineItems: LineItemFormData[] = invoice?.line_items?.map(
    (item) => ({
      id: item.id,
      description: item.description,
      quantity: item.quantity,
      rate: item.rate,
      amount: item.amount,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      discount_percent: item.discount_percent,
      discount_amount: item.discount_amount,
    }),
  ) || [createEmptyLineItem()]

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors },
  } = useForm<InvoiceFormData>({
    resolver: zodResolver(invoiceSchema) as Resolver<InvoiceFormData>,
    defaultValues: {
      client_id: invoice?.client_id || defaultClientId || '',
      invoice_number:
        invoice?.invoice_number ||
        formatInvoiceNumber(
          business.invoice_prefix,
          business.next_invoice_number,
        ),
      issue_date: invoice?.issue_date || todayISO(),
      due_date:
        invoice?.due_date ||
        format(
          addDays(new Date(), business.default_payment_terms),
          'yyyy-MM-dd',
        ),
      po_number: invoice?.po_number || '',
      currency: invoice?.currency || business.default_currency,
      line_items: defaultLineItems,
      subtotal: invoice?.subtotal || 0,
      discount_type: invoice?.discount_type || 'percentage',
      discount_value: invoice?.discount_value || 0,
      discount_amount: invoice?.discount_amount || 0,
      tax_rate: invoice?.tax_rate || 0,
      tax_amount: invoice?.tax_amount || 0,
      shipping_amount: invoice?.shipping_amount || 0,
      total: invoice?.total || 0,
      notes: invoice?.notes || business.invoice_notes || '',
      terms: invoice?.terms || '',
      footer: invoice?.footer || business.invoice_footer || '',
      payment_instructions: invoice?.payment_instructions || '',
      is_recurring: invoice?.is_recurring || false,
      recurring_interval:
        (invoice?.recurring_interval as InvoiceFormData['recurring_interval']) ||
        undefined,
      recurring_end_date: invoice?.recurring_end_date || undefined,
    },
  })

  const lineItems = watch('line_items')
  const discountType = watch('discount_type')
  const discountValue = watch('discount_value')
  const taxRate = watch('tax_rate')
  const shippingAmount = watch('shipping_amount')
  const currency = watch('currency')
  const clientId = watch('client_id')

  // Recalculate totals when line items or discounts change
  useEffect(() => {
    const totals = calculateInvoiceTotals(
      lineItems,
      discountType,
      discountValue,
      taxRate,
      shippingAmount,
    )
    setValue('subtotal', totals.subtotal)
    setValue('discount_amount', totals.discount_amount)
    setValue('tax_amount', totals.tax_amount)
    setValue('total', totals.total)
  }, [
    lineItems,
    discountType,
    discountValue,
    taxRate,
    shippingAmount,
    setValue,
  ])

  // Update due date when client changes
  useEffect(() => {
    if (clientId && !invoice) {
      const client = clients.find((c) => c.id === clientId)
      if (client) {
        setValue('currency', client.currency)
        setValue(
          'due_date',
          toISODate(addDays(new Date(), client.payment_terms)),
        )
      }
    }
  }, [clientId, clients, invoice, setValue])

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  }

  const handleFormSubmit = async (data: InvoiceFormData) => {
    setIsSubmitting(true)
    try {
      await onSubmit(data, submitType)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-6">
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        {/* Left Column - Main Form */}
        <div className="min-w-0 space-y-6">
          {/* Client & Invoice Info */}
          <Card>
            <CardHeader>
              <CardTitle>Invoice details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="client_id">Client *</Label>
                  <Controller
                    name="client_id"
                    control={control}
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select a client" />
                        </SelectTrigger>
                        <SelectContent>
                          {clients.map((client) => (
                            <SelectItem key={client.id} value={client.id}>
                              {client.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {errors.client_id && (
                    <p className="text-sm text-destructive">
                      {errors.client_id.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="invoice_number">Invoice Number *</Label>
                  <Input {...register('invoice_number')} />
                  {errors.invoice_number && (
                    <p className="text-sm text-destructive">
                      {errors.invoice_number.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Issue Date</Label>
                  <Controller
                    name="issue_date"
                    control={control}
                    render={({ field }) => (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            className={cn(
                              'w-full justify-start text-left font-normal',
                              !field.value && 'text-muted-foreground',
                            )}
                          >
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {field.value
                              ? format(parseDay(field.value), 'PPP')
                              : 'Pick a date'}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0">
                          <Calendar
                            mode="single"
                            selected={
                              field.value ? parseDay(field.value) : undefined
                            }
                            onSelect={(date) =>
                              field.onChange(date ? toISODate(date) : '')
                            }
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Due Date</Label>
                  <Controller
                    name="due_date"
                    control={control}
                    render={({ field }) => (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            className={cn(
                              'w-full justify-start text-left font-normal',
                              !field.value && 'text-muted-foreground',
                            )}
                          >
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {field.value
                              ? format(parseDay(field.value), 'PPP')
                              : 'Pick a date'}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0">
                          <Calendar
                            mode="single"
                            selected={
                              field.value ? parseDay(field.value) : undefined
                            }
                            onSelect={(date) =>
                              field.onChange(date ? toISODate(date) : '')
                            }
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="po_number">PO Number</Label>
                  <Input {...register('po_number')} placeholder="Optional" />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="currency">Currency</Label>
                  <Controller
                    name="currency"
                    control={control}
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="USD">USD</SelectItem>
                          <SelectItem value="EUR">EUR</SelectItem>
                          <SelectItem value="GBP">GBP</SelectItem>
                          <SelectItem value="CAD">CAD</SelectItem>
                          <SelectItem value="AUD">AUD</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Line items */}
          <Card>
            <CardHeader>
              <CardTitle>Line items</CardTitle>
            </CardHeader>
            <CardContent>
              <Controller
                name="line_items"
                control={control}
                render={({ field }) => (
                  <LineItemsEditor
                    items={field.value}
                    onChange={field.onChange}
                    currency={currency}
                  />
                )}
              />
              {errors.line_items && (
                <p className="mt-2 text-sm text-destructive">
                  {errors.line_items.message ||
                    'Please add at least one line item'}
                </p>
              )}
            </CardContent>
          </Card>

          {renderExtras?.({
            clientId,
            currency,
            lineItems,
            setLineItems: (items) =>
              setValue('line_items', items, { shouldDirty: true, shouldValidate: true }),
          })}

          {/* Notes & Terms */}
          <Card>
            <CardHeader>
              <CardTitle>Additional information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  {...register('notes')}
                  placeholder="Notes visible to client"
                  rows={3}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="terms">Terms & Conditions</Label>
                <Textarea
                  {...register('terms')}
                  placeholder="Payment terms, conditions, etc."
                  rows={3}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="payment_instructions">
                  Payment Instructions
                </Label>
                <Textarea
                  {...register('payment_instructions')}
                  placeholder="Bank details, payment methods, etc."
                  rows={3}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Summary */}
        <div className="space-y-6">
          <Card className="sticky top-6">
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Subtotal */}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="font-medium tabular-nums">
                  {formatCurrency(watch('subtotal'))}
                </span>
              </div>

              {/* Discount */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-muted-foreground">
                    Discount
                  </Label>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    {...register('discount_value', {
                      setValueAs: (v) => Number(v) || 0,
                    })}
                    className="w-20"
                  />
                  <Controller
                    name="discount_type"
                    control={control}
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger className="w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="percentage">%</SelectItem>
                          <SelectItem value="fixed">{currency}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <div className="flex flex-1 items-center justify-end text-sm text-muted-foreground">
                    -{formatCurrency(watch('discount_amount'))}
                  </div>
                </div>
              </div>

              {/* Tax */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-muted-foreground">
                    Tax Rate
                  </Label>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    {...register('tax_rate', {
                      setValueAs: (v) => Number(v) || 0,
                    })}
                    className="w-20"
                  />
                  <span className="flex items-center text-sm text-muted-foreground">
                    %
                  </span>
                  <div className="flex flex-1 items-center justify-end text-sm">
                    {formatCurrency(watch('tax_amount'))}
                  </div>
                </div>
              </div>

              {/* Shipping */}
              <div className="flex items-center justify-between">
                <Label className="text-sm text-muted-foreground">
                  Shipping
                </Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  {...register('shipping_amount', {
                    setValueAs: (v) => Number(v) || 0,
                  })}
                  className="w-32 text-right"
                />
              </div>

              {/* Total */}
              <div className="border-t pt-4">
                <div className="flex justify-between text-lg font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatCurrency(watch('total'))}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="space-y-2 pt-4">
                <Button
                  type="submit"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => setSubmitType('sent')}
                >
                  {isSubmitting && submitType === 'sent' && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Save & Send
                </Button>
                <Button
                  type="submit"
                  variant="outline"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => setSubmitType('draft')}
                >
                  {isSubmitting && submitType === 'draft' && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Save as Draft
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={onCancel}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </form>
  )
}

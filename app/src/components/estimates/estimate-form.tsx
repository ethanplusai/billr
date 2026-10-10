'use client'

import { useEffect, useState } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { format, addDays } from 'date-fns'
import { CalendarIcon, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Calendar } from '@/components/ui/calendar'
import {
  Form,
  FormControl,
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
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type {
  Client,
  Item,
  Business,
  Estimate,
  EstimateLineItem,
} from '@/types'
import { parseDay } from '@/lib/dates'

const lineItemSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  quantity: z.coerce.number().min(0.01, 'Quantity must be greater than 0'),
  rate: z.coerce.number().min(0, 'Rate must be positive'),
})

const estimateSchema = z.object({
  client_id: z.string().min(1, 'Please select a client'),
  issue_date: z.date(),
  expiry_date: z.date(),
  notes: z.string().optional(),
  terms: z.string().optional(),
  line_items: z.array(lineItemSchema).min(1, 'Add at least one line item'),
})

type EstimateFormData = z.infer<typeof estimateSchema>

interface LineItemData {
  id: string
  description: string
  quantity: number
  rate: number
}

interface EstimateFormProps {
  estimate?: Estimate & { line_items: EstimateLineItem[] }
  clients: Client[]
  items: Item[]
  business: Business
  onSubmit: (data: EstimateFormData, status: 'draft' | 'sent') => Promise<void>
  onCancel: () => void
  defaultClientId?: string
}

export function EstimateForm({
  estimate,
  clients,
  items,
  business,
  onSubmit,
  onCancel,
  defaultClientId,
}: EstimateFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitType, setSubmitType] = useState<'draft' | 'sent'>('draft')
  const [lineItems, setLineItems] = useState<LineItemData[]>(
    estimate?.line_items?.map((item) => ({
      id: item.id,
      description: item.description,
      quantity: item.quantity,
      rate: item.rate,
    })) || [{ id: '1', description: '', quantity: 1, rate: 0 }],
  )

  const form = useForm<EstimateFormData>({
    resolver: zodResolver(estimateSchema) as Resolver<EstimateFormData>,
    defaultValues: {
      client_id: estimate?.client_id || defaultClientId || '',
      issue_date: estimate ? parseDay(estimate.issue_date) : new Date(),
      expiry_date: estimate?.expiry_date
        ? parseDay(estimate.expiry_date)
        : addDays(new Date(), 30),
      notes: estimate?.notes || '',
      terms: estimate?.terms || business.invoice_notes || '',
      line_items: estimate?.line_items?.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        rate: item.rate,
      })) || [{ description: '', quantity: 1, rate: 0 }],
    },
  })

  // Keep the form's line_items in sync with the editor state so zod
  // validation runs against the current items on submit
  useEffect(() => {
    form.setValue(
      'line_items',
      lineItems.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        rate: item.rate,
      })),
    )
  }, [lineItems, form])

  const addLineItem = () => {
    const newItem: LineItemData = {
      id: crypto.randomUUID(),
      description: '',
      quantity: 1,
      rate: 0,
    }
    setLineItems([...lineItems, newItem])
  }

  const removeLineItem = (id: string) => {
    if (lineItems.length === 1) return
    setLineItems(lineItems.filter((item) => item.id !== id))
  }

  const updateLineItem = (
    id: string,
    field: keyof LineItemData,
    value: string | number,
  ) => {
    setLineItems(
      lineItems.map((item) =>
        item.id === id ? { ...item, [field]: value } : item,
      ),
    )
  }

  const addItemFromCatalog = (item: Item) => {
    const newItem: LineItemData = {
      id: crypto.randomUUID(),
      description: item.description || item.name,
      quantity: 1,
      rate: item.rate,
    }
    setLineItems([...lineItems, newItem])
  }

  const subtotal = lineItems.reduce((sum, item) => {
    return sum + item.quantity * item.rate
  }, 0)

  const total = subtotal

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: business.default_currency,
    }).format(amount)
  }

  const handleFormSubmit = async (data: EstimateFormData) => {
    setIsSubmitting(true)
    try {
      await onSubmit(data, submitType)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleFormSubmit)}
        className="space-y-6"
      >
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          {/* Main Content */}
          <div className="min-w-0 space-y-6">
            {/* Client Selection */}
            <Card>
              <CardContent className="pt-6">
                <FormField
                  control={form.control}
                  name="client_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Client</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a client" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {clients.map((client) => (
                            <SelectItem key={client.id} value={client.id}>
                              {client.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Line items */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Line items</CardTitle>
                {items.length > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm">
                        Add from catalog
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64" align="end">
                      <div className="space-y-1">
                        {items.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => addItemFromCatalog(item)}
                            className="w-full rounded-md p-2 text-left text-sm hover:bg-accent"
                          >
                            <p className="font-medium">{item.name}</p>
                            <p className="text-muted-foreground">
                              {formatCurrency(item.rate)}
                              {item.unit && ` / ${item.unit}`}
                            </p>
                          </button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {/* Header */}
                  <div className="hidden grid-cols-[minmax(0,1fr)_72px_100px_120px] gap-4 text-xs font-medium text-muted-foreground sm:grid">
                    <div className="min-w-0">Description</div>
                    <div className="text-right">Qty</div>
                    <div className="text-right">Rate</div>
                    <div className="text-right">Amount</div>
                  </div>

                  {/* Items */}
                  {lineItems.map((item) => (
                    <div
                      key={item.id}
                      className="grid grid-cols-12 items-end gap-3 border-b border-zinc-100 pb-4 sm:grid-cols-[minmax(0,1fr)_72px_100px_120px] sm:gap-4"
                    >
                      <div className="col-span-12 min-w-0 sm:col-span-1">
                        <Input
                          aria-label="Line item description"
                          placeholder="Description"
                          value={item.description}
                          onChange={(e) =>
                            updateLineItem(
                              item.id,
                              'description',
                              e.target.value,
                            )
                          }
                        />
                      </div>
                      <div className="col-span-3 min-w-0 sm:col-span-1">
                        <span className="mb-2 block text-xs text-zinc-500 sm:hidden">
                          Quantity
                        </span>
                        <Input
                          type="number"
                          min="0.01"
                          step="0.01"
                          aria-label="Quantity"
                          value={item.quantity}
                          onChange={(e) =>
                            updateLineItem(
                              item.id,
                              'quantity',
                              parseFloat(e.target.value) || 0,
                            )
                          }
                          className="text-right"
                        />
                      </div>
                      <div className="col-span-3 min-w-0 sm:col-span-1">
                        <span className="mb-2 block text-xs text-zinc-500 sm:hidden">
                          Rate
                        </span>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          aria-label="Rate"
                          value={item.rate}
                          onChange={(e) =>
                            updateLineItem(
                              item.id,
                              'rate',
                              parseFloat(e.target.value) || 0,
                            )
                          }
                          className="text-right"
                        />
                      </div>
                      <div className="col-span-6 flex min-h-10 min-w-0 items-center justify-between gap-1 sm:col-span-1">
                        <span className="font-medium tabular-nums">
                          {formatCurrency(item.quantity * item.rate)}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Remove line item"
                          onClick={() => removeLineItem(item.id)}
                          disabled={lineItems.length === 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}

                  <Button
                    type="button"
                    variant="outline"
                    onClick={addLineItem}
                    className="w-full"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add Line Item
                  </Button>
                </div>

                {form.formState.errors.line_items && (
                  <p className="mt-2 text-sm text-destructive">
                    {form.formState.errors.line_items.message ||
                      'Each line item needs a description'}
                  </p>
                )}

                {/* Totals */}
                <div className="mt-6 flex justify-end">
                  <div className="w-64 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Subtotal</span>
                      <span className="tabular-nums">
                        {formatCurrency(subtotal)}
                      </span>
                    </div>
                    <Separator />
                    <div className="flex justify-between font-bold">
                      <span>Total</span>
                      <span className="tabular-nums">
                        {formatCurrency(total)}
                      </span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Notes & Terms */}
            <Card>
              <CardContent className="pt-6">
                <div className="grid gap-6 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Notes</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Notes visible to client"
                            rows={4}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="terms"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Terms & Conditions</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Terms and conditions"
                            rows={4}
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
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Dates */}
            <Card>
              <CardContent className="pt-6 space-y-4">
                <FormField
                  control={form.control}
                  name="issue_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Estimate Date</FormLabel>
                      <Popover>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <Button
                              variant="outline"
                              className={cn(
                                'w-full justify-start text-left font-normal',
                                !field.value && 'text-muted-foreground',
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
                  name="expiry_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Valid Until</FormLabel>
                      <Popover>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <Button
                              variant="outline"
                              className={cn(
                                'w-full justify-start text-left font-normal',
                                !field.value && 'text-muted-foreground',
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
              </CardContent>
            </Card>

            {/* Actions */}
            <Card>
              <CardContent className="pt-6 space-y-3">
                <Button
                  type="submit"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => setSubmitType('sent')}
                >
                  Save & Send
                </Button>
                <Button
                  type="submit"
                  variant="outline"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => setSubmitType('draft')}
                >
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
              </CardContent>
            </Card>
          </div>
        </div>
      </form>
    </Form>
  )
}

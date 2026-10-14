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
import { Checkbox } from '@/components/ui/checkbox'
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
import type { TimeEntry, Client } from '@/types'
import { entrySeconds, timeAmount } from '@/lib/work/time'
import { parseDay } from '@/lib/dates'

const timeEntrySchema = z.object({
  client_id: z.string().optional(),
  description: z.string().min(1, 'Description is required'),
  hours: z.coerce.number().min(1 / 3600, 'Log at least one second').max(24),
  rate: z.preprocess((value) => value === '' || value == null ? null : value, z.coerce.number().min(0).nullable()),
  date: z.date(),
  is_billable: z.boolean(),
  project_name: z.string().optional(),
})

export type TimeEntryFormData = z.infer<typeof timeEntrySchema>

interface TimeEntryFormProps {
  entry?: TimeEntry
  clients: Client[]
  defaultRate?: number | null
  currency?: string
  onSubmit: (data: TimeEntryFormData) => Promise<void>
  onCancel: () => void
}

export function TimeEntryForm({
  entry,
  clients,
  defaultRate = null,
  currency = 'USD',
  onSubmit,
  onCancel,
}: TimeEntryFormProps) {
  const form = useForm<TimeEntryFormData>({
    resolver: zodResolver(timeEntrySchema) as Resolver<TimeEntryFormData>,
    defaultValues: {
      client_id: entry?.client_id || '',
      description: entry?.description || '',
      hours: entry ? entrySeconds(entry) / 3600 : 1,
      rate: entry ? entry.hourly_rate : defaultRate,
      date: entry ? parseDay(entry.date) : new Date(),
      is_billable: entry?.is_billable ?? true,
      project_name: entry?.project_name || '',
    },
  })

  const isBillable = form.watch('is_billable')
  const hours = form.watch('hours') || 0
  const rate = form.watch('rate')
  const amount = rate === null ? null : Number.isFinite(hours) && Number.isFinite(rate) && hours >= 0 && rate >= 0 ? timeAmount(Math.round(hours * 3600), rate) : null

  const handleSubmit = async (data: TimeEntryFormData) => {
    await onSubmit(data)
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: displayCurrency,
    }).format(amount)
  }

  const selectedClientId=form.watch('client_id')
  const displayCurrency=clients.find(c=>c.id===selectedClientId)?.currency || currency

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <Card>
          <CardContent className="pt-6">
            <div className="grid gap-6 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
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
                          autoFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="client_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Client (Optional)</FormLabel>
                    <Select value={field.value || 'none'} onValueChange={(value) => field.onChange(value === 'none' ? '' : value)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select client" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">No client</SelectItem>
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

              <FormField
                control={form.control}
                name="project_name"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Project (Optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Website Redesign" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="What did you work on?"
                        rows={3}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="hours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Hours</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="any"
                        min="0.0002777778"
                        placeholder="0.00"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="rate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Rate per hour ({displayCurrency})</FormLabel>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                          {displayCurrency}
                        </span>
                        <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          className="pl-14"
                          disabled={!isBillable}
                          {...field}
                          value={field.value ?? ''}
                        />
                        </FormControl>
                      </div>

                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="is_billable"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-3 space-y-0 rounded-lg border p-4 sm:col-span-2">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className="flex-1">
                      <FormLabel className="cursor-pointer">Billable</FormLabel>
                      <FormDescription>
                        This time can be added to an invoice
                      </FormDescription>
                    </div>
                    {isBillable && (
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">Amount</p>
                        <p className="text-lg font-bold tabular-nums">
                          {amount === null ? 'Rate needed' : formatCurrency(amount)}
                        </p>
                      </div>
                    )}
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
            {form.formState.isSubmitting
              ? 'Saving...'
              : entry
              ? 'Update Entry'
              : 'Log Time'}
          </Button>
        </div>
      </form>
    </Form>
  )
}


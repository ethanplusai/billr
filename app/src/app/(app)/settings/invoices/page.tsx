'use client'

import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/shared/page-header'
import { SettingsLayout } from '@/components/settings/settings-layout'
import { useBusiness } from '@/lib/hooks/use-business'
import { updateInvoiceDefaultsAction } from '@/lib/actions/business'

const invoiceSettingsSchema = z.object({
  default_currency: z.string(),
  default_payment_terms: z.number().int().min(0),
  invoice_prefix: z.string().min(1),
  estimate_prefix: z.string().min(1),
  invoice_notes: z.string().optional(),
  invoice_footer: z.string().optional(),
})

type InvoiceSettingsForm = z.infer<typeof invoiceSettingsSchema>

export default function InvoiceSettingsPage() {
  const { currentBusiness, refreshBusinesses, isLoading } = useBusiness()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
  } = useForm<InvoiceSettingsForm>({
    resolver: zodResolver(invoiceSettingsSchema),
    defaultValues: {
      default_currency: currentBusiness?.default_currency || 'USD',
      default_payment_terms: currentBusiness?.default_payment_terms || 30,
      invoice_prefix: currentBusiness?.invoice_prefix || 'INV',
      estimate_prefix: currentBusiness?.estimate_prefix || 'EST',
      invoice_notes: currentBusiness?.invoice_notes || '',
      invoice_footer: currentBusiness?.invoice_footer || '',
    },
  })

  const currency = watch('default_currency')

  // Businesses load asynchronously; sync the form once data arrives
  useEffect(() => {
    if (currentBusiness) {
      reset({
        default_currency: currentBusiness.default_currency || 'USD',
        default_payment_terms: currentBusiness.default_payment_terms || 30,
        invoice_prefix: currentBusiness.invoice_prefix || 'INV',
        estimate_prefix: currentBusiness.estimate_prefix || 'EST',
        invoice_notes: currentBusiness.invoice_notes || '',
        invoice_footer: currentBusiness.invoice_footer || '',
      })
    }
  }, [currentBusiness, reset])

  async function onSubmit(data: InvoiceSettingsForm) {
    if (!currentBusiness) return

    setIsSubmitting(true)
    setMessage(null)

    const result = await updateInvoiceDefaultsAction(currentBusiness.id, data)

    setIsSubmitting(false)

    if ('error' in result) {
      setMessage({ type: 'error', text: result.error })
    } else {
      setMessage({ type: 'success', text: 'Invoice settings updated' })
      refreshBusinesses()
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!currentBusiness) {
    return null
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="Settings"
        description="Manage your business settings and preferences"
      />

      <div className="mt-6">
        <SettingsLayout>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            {message && (
              <div
                className={`rounded-lg p-3 text-sm ${
                  message.type === 'success'
                    ? 'bg-green-50 text-green-800'
                    : 'bg-red-50 text-red-800'
                }`}
              >
                {message.text}
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Invoice Defaults</CardTitle>
                <CardDescription>
                  Default settings for new invoices and estimates
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="default_currency">Default Currency</Label>
                    <Select
                      value={currency}
                      onValueChange={(value) => setValue('default_currency', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">USD - US Dollar</SelectItem>
                        <SelectItem value="EUR">EUR - Euro</SelectItem>
                        <SelectItem value="GBP">GBP - British Pound</SelectItem>
                        <SelectItem value="CAD">CAD - Canadian Dollar</SelectItem>
                        <SelectItem value="AUD">AUD - Australian Dollar</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="default_payment_terms">Payment Terms (days)</Label>
                    <Input
                      id="default_payment_terms"
                      type="number"
                      min={0}
                      {...register('default_payment_terms', { valueAsNumber: true })}
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="invoice_prefix">Invoice Number Prefix</Label>
                    <Input id="invoice_prefix" {...register('invoice_prefix')} />
                    <p className="text-xs text-muted-foreground">
                      Next invoice: {currentBusiness.invoice_prefix}-
                      {String(currentBusiness.next_invoice_number).padStart(4, '0')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="estimate_prefix">Estimate Number Prefix</Label>
                    <Input id="estimate_prefix" {...register('estimate_prefix')} />
                    <p className="text-xs text-muted-foreground">
                      Next estimate: {currentBusiness.estimate_prefix}-
                      {String(currentBusiness.next_estimate_number).padStart(4, '0')}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Default Text</CardTitle>
                <CardDescription>
                  Default notes and footer that will appear on new invoices
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="invoice_notes">Default Notes</Label>
                  <Textarea
                    id="invoice_notes"
                    {...register('invoice_notes')}
                    placeholder="Thank you for your business!"
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">
                    Shown in the notes section of invoices
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="invoice_footer">Default Footer</Label>
                  <Textarea
                    id="invoice_footer"
                    {...register('invoice_footer')}
                    placeholder="Company registration number, terms, etc."
                    rows={2}
                  />
                  <p className="text-xs text-muted-foreground">
                    Shown at the bottom of invoices
                  </p>
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </form>
        </SettingsLayout>
      </div>
    </div>
  )
}


'use client'

import { Suspense, useEffect, useMemo, useState, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/shared/page-header'
import { InvoiceForm } from '@/components/invoices/invoice-form'
import {
  EngagementEntryPicker,
  engagementEntryIdsOf,
  typedLineItemsOf,
} from '@/components/engagements/engagement-entry-picker'
import { useBusiness } from '@/lib/hooks/use-business'
import type { Client, Invoice, InvoiceLineItem } from '@/types'
import type { InvoiceFormData } from '@/lib/validations/invoice'

type InvoiceWithLineItems = Invoice & { line_items: InvoiceLineItem[] }

export default function NewInvoicePage() {
  return (
    <Suspense>
      <NewInvoicePageInner />
    </Suspense>
  )
}

function NewInvoicePageInner() {
  const router = useRouter()
  const requestId = useRef<string | null>(null)
  const searchParams = useSearchParams()
  const defaultClientId = searchParams.get('client') || undefined
  const duplicateId = searchParams.get('duplicate')
  // Schedule entries to tick on arrival. list_ready_to_bill and the "Draft
  // invoice from ready entries" button on an engagement both link here with
  // them, so the person lands on a form that is already right.
  const preselectedEntries = useMemo(
    () => (searchParams.get('engagement_entries') || '').split(',').filter(Boolean),
    [searchParams],
  )
  const { currentBusiness } = useBusiness()
  const [clients, setClients] = useState<Client[]>([])
  const [sourceInvoice, setSourceInvoice] = useState<InvoiceWithLineItems | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      if (!currentBusiness) return

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('business_id', currentBusiness.id)
        .eq('is_active', true)
        .order('name')

      if (data) {
        setClients(data)
      }

      if (duplicateId) {
        const { data: invoiceData } = await supabase
          .from('invoices')
          .select(`
            *,
            line_items:invoice_line_items(*)
          `)
          .eq('id', duplicateId)
          .single()

        if (invoiceData) {
          // Clear the invoice number so a fresh one is assigned
          setSourceInvoice({
            ...(invoiceData as InvoiceWithLineItems),
            invoice_number: '',
          })
        }
      }
      setIsLoading(false)
    }

    fetchData()
  }, [currentBusiness, duplicateId])

  async function handleSubmit(data: InvoiceFormData, status: 'draft' | 'sent') {
    if (!currentBusiness) return

    // The engagement preview lines go back out here. What reaches the server
    // is the entry ids, and the amounts are rebuilt in SQL from the agreed
    // schedule, so a rate edited in the browser cannot re-price agreed work.
    const engagementEntryIds = engagementEntryIdsOf(data.line_items)
    const typed = typedLineItemsOf(data.line_items)

    const { createInvoiceAction } = await import('@/lib/actions/invoices')
    requestId.current ??= crypto.randomUUID()
    const invoice = await createInvoiceAction(
      currentBusiness.id,
      { ...data, line_items: typed },
      status,
      requestId.current,
      engagementEntryIds,
    )
    router.push(`/invoices/${invoice.id}${status === 'sent' ? '?compose=1' : ''}`)
  }

  if (!currentBusiness || isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="New Invoice"
        description="Create a new invoice for your client"
      />

      <div className="mt-6">
        <InvoiceForm
          invoice={sourceInvoice || undefined}
          clients={clients}
          business={currentBusiness}
          onSubmit={handleSubmit}
          onCancel={() => router.back()}
          defaultClientId={defaultClientId}
          renderExtras={({ clientId, currency, lineItems, setLineItems }) => (
            <EngagementEntryPicker
              businessId={currentBusiness.id}
              clientId={clientId}
              currency={currency}
              lineItems={lineItems}
              setLineItems={setLineItems}
              preselected={preselectedEntries}
            />
          )}
        />
      </div>
    </div>
  )
}

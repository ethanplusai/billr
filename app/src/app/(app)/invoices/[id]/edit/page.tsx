'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { FileText } from 'lucide-react'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { InvoiceForm } from '@/components/invoices/invoice-form'
import { useBusiness } from '@/lib/hooks/use-business'
import type { Client, Invoice, InvoiceLineItem } from '@/types'
import type { InvoiceFormData } from '@/lib/validations/invoice'

type InvoiceWithLineItems = Invoice & { line_items: InvoiceLineItem[] }

export default function EditInvoicePage() {
  const params = useParams()
  const router = useRouter()
  const invoiceId = params.id as string
  const { currentBusiness } = useBusiness()
  const [invoice, setInvoice] = useState<InvoiceWithLineItems | null>(null)
  const [clients, setClients] = useState<Client[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      if (!currentBusiness) return

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      const [invoiceRes, clientsRes] = await Promise.all([
        supabase
          .from('invoices')
          .select(`
            *,
            line_items:invoice_line_items(*)
          `)
          .eq('id', invoiceId)
          .single(),
        supabase
          .from('clients')
          .select('*')
          .eq('business_id', currentBusiness.id)
          .eq('is_active', true)
          .order('name'),
      ])

      if (invoiceRes.data) {
        setInvoice(invoiceRes.data as InvoiceWithLineItems)
      }
      if (clientsRes.data) {
        setClients(clientsRes.data)
      }
      setIsLoading(false)
    }

    fetchData()
  }, [currentBusiness, invoiceId])

  async function handleSubmit(data: InvoiceFormData, status: 'draft' | 'sent') {
    if (!currentBusiness) return

    const { updateInvoiceAction } = await import('@/lib/actions/invoices')
    await updateInvoiceAction(invoiceId, data)
    router.push(`/invoices/${invoiceId}${status === 'sent' ? '?compose=1' : ''}`)
  }

  if (!currentBusiness || isLoading) {
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

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title={`Edit ${invoice.invoice_number}`}
        description="Update the details of this invoice"
      />

      <div className="mt-6">
        <InvoiceForm
          invoice={invoice}
          clients={clients}
          business={currentBusiness}
          onSubmit={handleSubmit}
          onCancel={() => router.back()}
        />
      </div>
    </div>
  )
}

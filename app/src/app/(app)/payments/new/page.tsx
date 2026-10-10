'use client'

import { Suspense, useEffect, useState, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/shared/page-header'
import { PaymentForm, type PaymentFormData } from '@/components/payments/payment-form'
import { useBusiness } from '@/lib/hooks/use-business'
import type { Invoice, Client } from '@/types'

import { toast } from 'sonner'
import { toISODate } from '@/lib/dates'
import { recordPaymentAction } from '@/lib/actions/payments'

export default function NewPaymentPage() {
  return (
    <Suspense>
      <NewPaymentPageInner />
    </Suspense>
  )
}

function NewPaymentPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const defaultInvoiceId = searchParams.get('invoice') || undefined
  const { currentBusiness } = useBusiness()
  const [invoices, setInvoices] = useState<(Invoice & { client: Client })[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchInvoices() {
      if (!currentBusiness) return

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data } = await supabase
        .from('invoices')
        .select('*, client:clients(*)')
        .eq('business_id', currentBusiness.id)
        .gt('balance_due', 0)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false })

      if (data) {
        setInvoices(data as (Invoice & { client: Client })[])
      }
      setIsLoading(false)
    }

    fetchInvoices()
  }, [currentBusiness])

  const paymentRequest = useRef<string | null>(null)
  async function handleSubmit(data: PaymentFormData) {
    if (!currentBusiness) return

    const invoice = invoices.find((inv) => inv.id === data.invoice_id)
    if (!invoice) return

    // One transaction on the server: recordPaymentAction calls
    // record_payment_once, which inserts the ledger row and
    // recomputes the invoice from SUM(payments) together. business_id,
    // client_id and currency come from the invoice inside the RPC rather than
    // from here.
    const result = await recordPaymentAction(
      currentBusiness.id,
      {
        invoice_id: data.invoice_id,
        amount: data.amount,
        payment_date: toISODate(data.payment_date),
        payment_method: data.payment_method,
        reference_number: data.reference_number || null,
        notes: data.notes || null,
      },
      (paymentRequest.current ??= crypto.randomUUID()),
    )

    if ('error' in result) {
      toast.error(result.error)
      return
    }

    router.push('/payments')
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
        title="Record Payment"
        description="Record a payment received for an invoice"
      />

      <div className="mt-6 max-w-2xl">
        <PaymentForm
          invoices={invoices}
          onSubmit={handleSubmit}
          onCancel={() => router.back()}
          defaultInvoiceId={defaultInvoiceId}
        />
      </div>
    </div>
  )
}


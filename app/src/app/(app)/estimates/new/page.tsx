'use client'

import { Suspense, useEffect, useState, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/shared/page-header'
import { EstimateForm } from '@/components/estimates/estimate-form'
import { useBusiness } from '@/lib/hooks/use-business'
import type { Client, Item } from '@/types'

import { toISODate } from '@/lib/dates'

export default function NewEstimatePage() {
  return (
    <Suspense>
      <NewEstimatePageInner />
    </Suspense>
  )
}

function NewEstimatePageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const defaultClientId = searchParams.get('client') || undefined
  const { currentBusiness } = useBusiness()
  const [clients, setClients] = useState<Client[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      if (!currentBusiness) return

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      
      const [clientsRes, itemsRes] = await Promise.all([
        supabase
          .from('clients')
          .select('*')
          .eq('business_id', currentBusiness.id)
          .eq('is_active', true)
          .order('name'),
        supabase
          .from('items')
          .select('*')
          .eq('business_id', currentBusiness.id)
          .eq('is_active', true)
          .order('name'),
      ])

      if (clientsRes.data) setClients(clientsRes.data)
      if (itemsRes.data) setItems(itemsRes.data as Item[])
      setIsLoading(false)
    }

    fetchData()
  }, [currentBusiness])

  const requestId=useRef<string | null>(null)
  async function handleSubmit(data: unknown, status: 'draft' | 'sent') {
    if (!currentBusiness) return

    const formData = data as {
      client_id: string
      issue_date: Date
      expiry_date: Date
      notes?: string
      terms?: string
      line_items: { description: string; quantity: number; rate: number }[]
    }

    const { createEstimateAction } = await import('@/lib/actions/estimates')
    requestId.current ??= crypto.randomUUID()
    const estimate = await createEstimateAction(
      currentBusiness.id,
      {
        client_id: formData.client_id,
        issue_date: toISODate(formData.issue_date),
        expiry_date: toISODate(formData.expiry_date),
        notes: formData.notes,
        terms: formData.terms,
        line_items: formData.line_items,
      },
      status, requestId.current
    )
    router.push(`/estimates/${estimate.id}${status === 'sent' ? '?compose=1' : ''}`)
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
        title="New Estimate"
        description="Create a quote for your client"
      />

      <div className="mt-6">
        <EstimateForm
          clients={clients}
          items={items}
          business={currentBusiness}
          onSubmit={handleSubmit}
          onCancel={() => router.back()}
          defaultClientId={defaultClientId}
        />
      </div>
    </div>
  )
}


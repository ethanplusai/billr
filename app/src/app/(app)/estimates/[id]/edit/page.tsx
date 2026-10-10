'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { FileText } from 'lucide-react'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { EstimateForm } from '@/components/estimates/estimate-form'
import { useBusiness } from '@/lib/hooks/use-business'
import type { Client, Item, Estimate, EstimateLineItem } from '@/types'

import { toISODate } from '@/lib/dates'

type EstimateWithLineItems = Estimate & { line_items: EstimateLineItem[] }

export default function EditEstimatePage() {
  const params = useParams()
  const router = useRouter()
  const estimateId = params.id as string
  const { currentBusiness } = useBusiness()
  const [estimate, setEstimate] = useState<EstimateWithLineItems | null>(null)
  const [clients, setClients] = useState<Client[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      if (!currentBusiness) return

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      const [estimateRes, clientsRes, itemsRes] = await Promise.all([
        supabase
          .from('estimates')
          .select(`
            *,
            line_items:estimate_line_items(*)
          `)
          .eq('id', estimateId)
          .single(),
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

      if (estimateRes.data) {
        setEstimate(estimateRes.data as EstimateWithLineItems)
      }
      if (clientsRes.data) setClients(clientsRes.data)
      if (itemsRes.data) setItems(itemsRes.data as Item[])
      setIsLoading(false)
    }

    fetchData()
  }, [currentBusiness, estimateId])

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

    const { updateEstimateAction } = await import('@/lib/actions/estimates')
    await updateEstimateAction(estimateId, {
      client_id: formData.client_id,
      issue_date: toISODate(formData.issue_date),
      expiry_date: toISODate(formData.expiry_date),
      notes: formData.notes,
      terms: formData.terms,
      line_items: formData.line_items,
    })
    router.push(`/estimates/${estimateId}${status === 'sent' ? '?compose=1' : ''}`)
  }

  if (!currentBusiness || isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!estimate) {
    return (
      <div className="p-6 lg:p-8">
        <EmptyState
          icon={FileText}
          title="Estimate not found"
          description="The estimate you're looking for doesn't exist."
          action={{ label: 'Back to Estimates', href: '/estimates' }}
        />
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title={`Edit ${estimate.estimate_number}`}
        description="Update the details of this estimate"
      />

      <div className="mt-6">
        <EstimateForm
          estimate={estimate}
          clients={clients}
          items={items}
          business={currentBusiness}
          onSubmit={handleSubmit}
          onCancel={() => router.back()}
        />
      </div>
    </div>
  )
}
